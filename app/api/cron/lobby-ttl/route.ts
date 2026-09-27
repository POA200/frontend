import { NextResponse } from "next/server"

import { vaultKickAsPlatform } from "@/lib/vault/submit"
import { vaultConfigured } from "@/lib/vault/config"
import { isChainId } from "@/lib/chain"
import { apiUrl, env, LOCAL_INTERNAL_API_SECRET } from "@/lib/config"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

type StaleSeat = {
    userId: string
    address: string
    paidMicro: number
    isCreator: boolean
}

type StaleLobby = {
    lobby: {
        id: string
        path: string
        entryAmountMicro: number
        chain: string
    }
    seats: StaleSeat[]
}

function apiBase() {
    return apiUrl()
}

function cronAuthorized(request: Request): boolean {
    const secrets = [
        process.env.CRON_SECRET?.trim(),
        env("INTERNAL_API_SECRET", LOCAL_INTERNAL_API_SECRET),
    ].filter((value): value is string => Boolean(value))
    if (secrets.length === 0) return false
    const header = request.headers.get("authorization")
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null
    const internal = request.headers.get("x-internal-secret")
    return Boolean(
        (bearer && secrets.includes(bearer)) ||
        (internal && secrets.includes(internal))
    )
}

async function internalFetch(path: string, init?: RequestInit) {
    const secret = env("INTERNAL_API_SECRET", LOCAL_INTERNAL_API_SECRET)
    if (!secret) {
        throw new Error("INTERNAL_API_SECRET is not configured")
    }
    const response = await fetch(`${apiBase()}${path}`, {
        ...init,
        headers: {
            "content-type": "application/json",
            "x-internal-secret": secret,
            ...(init?.headers ?? {}),
        },
        cache: "no-store",
    })
    if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`${path} failed (${response.status}): ${body}`)
    }
    return response.json()
}

/**
 * Stale-lobby janitor.
 *
 * - Waiting lobbies older than 24h (`/admin/lobbies/stale`) are refunded seat by
 *   seat (on-chain kick), then deleted.
 * - Live lobbies whose match actor died with the server
 *   (`/admin/lobbies/stale-live`) are refunded the same way, then finished with a
 *   `voided` payload instead of being deleted, so the room can explain itself.
 *
 * Free lobbies are also purged by the Rust janitor; this route owns the paid work.
 */
export async function GET(request: Request) {
    if (!cronAuthorized(request)) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }

    const waiting = await sweep("/admin/lobbies/stale", "expire")
    const live = await sweep("/admin/lobbies/stale-live", "void")

    const results = [...waiting, ...live]
    const summary = {
        scanned: results.length,
        expired: waiting.filter((r) => r.ok).length,
        voided: live.filter((r) => r.ok).length,
        results,
    }
    console.info("[lobby-ttl]", JSON.stringify(summary))
    return NextResponse.json(summary)
}

type SweepResult = {
    lobbyId: string
    path: string
    ok: boolean
    error?: string
}

/**
 * Refund every seat of each stale lobby, then close it out on the backend.
 * A lobby that fails here is retried on the next run — the backend drops each
 * seat as it is confirmed, so a retry never kicks an already-refunded seat.
 */
async function sweep(
    listPath: string,
    closeAction: "expire" | "void"
): Promise<SweepResult[]> {
    const stale = (await internalFetch(listPath)) as StaleLobby[]
    const results: SweepResult[] = []

    for (const item of stale) {
        try {
            // Every on-chain seat needs a kick (including sponsored guests, whose
            // seat left the vault map with a zero amount).
            for (const seat of item.seats) {
                let vaultTxid: string | undefined
                if (item.lobby.entryAmountMicro > 0) {
                    if (!vaultConfigured()) {
                        throw new Error(
                            "vault not configured; cannot refund paid lobby"
                        )
                    }
                    if (!isChainId(item.lobby.chain)) {
                        throw new Error("stale lobby is missing a chain")
                    }
                    vaultTxid = await vaultKickAsPlatform({
                        targetAddress: seat.address,
                        lobbyPath: item.lobby.path,
                        paidMicro: seat.paidMicro,
                        nonce: Date.now() + Math.floor(Math.random() * 1000),
                        chain: item.lobby.chain,
                    })
                }
                await internalFetch(
                    `/admin/lobbies/${item.lobby.id}/${closeAction}-seat`,
                    {
                        method: "POST",
                        body: JSON.stringify({
                            userId: seat.userId,
                            address: seat.address,
                            vaultTxid: vaultTxid ?? null,
                        }),
                    }
                )
            }

            await internalFetch(
                `/admin/lobbies/${item.lobby.id}/${closeAction}`,
                { method: "POST", body: "{}" }
            )
            results.push({
                lobbyId: item.lobby.id,
                path: item.lobby.path,
                ok: true,
            })
        } catch (error) {
            results.push({
                lobbyId: item.lobby.id,
                path: item.lobby.path,
                ok: false,
                error: error instanceof Error ? error.message : "sweep failed",
            })
        }
    }

    return results
}

export async function POST(request: Request) {
    return GET(request)
}
