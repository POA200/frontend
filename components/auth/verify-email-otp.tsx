"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"

import { authClient } from "@/lib/auth/client"
import {
    verifyEmailOtpSchema,
    type VerifyEmailOtpFormValues,
} from "@/lib/auth/schemas"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type VerifyEmailOtpProps = {
    email: string
    /** Used to sign in if verification did not establish a session. */
    password?: string
    onVerified: () => void
    onBack: () => void
}

export function VerifyEmailOtp({
    email,
    password,
    onVerified,
    onBack,
}: VerifyEmailOtpProps) {
    const [resendMessage, setResendMessage] = React.useState<string | null>(
        null
    )
    const [resending, setResending] = React.useState(false)
    const {
        register,
        handleSubmit,
        formState: { errors, isSubmitting },
        setError,
    } = useForm<VerifyEmailOtpFormValues>({
        resolver: zodResolver(verifyEmailOtpSchema),
        defaultValues: { otp: "" },
    })

    /**
     * Verification signs the user in, but only if the server cookie lands. If it
     * did not, fall back to a normal sign-in so the caller can enter the app.
     */
    async function ensureSignedIn(token?: string | null) {
        if (token) return true
        const { data: session } = await authClient.getSession({
            query: { disableCookieCache: true },
        })
        if (session?.user) return true
        if (!password) return false
        const { error } = await authClient.signIn.email({ email, password })
        return !error
    }

    async function onSubmit(values: VerifyEmailOtpFormValues) {
        setResendMessage(null)
        const { data, error } = await authClient.emailOtp.verifyEmail({
            email,
            otp: values.otp,
        })
        if (error) {
            setError("root", {
                message: error.message || "Invalid or expired code.",
            })
            return
        }
        if (!data?.user?.emailVerified && !data?.status) {
            setError("root", {
                message: "Could not verify that code. Try again.",
            })
            return
        }
        if (!(await ensureSignedIn(data?.token))) {
            setError("root", {
                message:
                    "Email verified, but we could not sign you in. Log in to continue.",
            })
            return
        }
        onVerified()
    }

    async function onResend() {
        setResendMessage(null)
        setResending(true)
        try {
            const { error } = await authClient.emailOtp.sendVerificationOtp({
                email,
                type: "email-verification",
            })
            if (error) {
                setError("root", {
                    message: error.message || "Could not resend the code.",
                })
                return
            }
            setResendMessage("A new code is on its way.")
        } finally {
            setResending(false)
        }
    }

    return (
        <div className="w-full">
            <h1 className="font-display text-3xl tracking-tight">
                Verify email
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
                Enter the 6-digit code we sent to{" "}
                <span className="font-medium text-foreground">{email}</span>.
            </p>
            <form
                onSubmit={handleSubmit(onSubmit)}
                className="mt-8 space-y-4"
                noValidate
            >
                <div className="grid gap-2">
                    <Label htmlFor="otp">Verification code</Label>
                    <Input
                        id="otp"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        autoFocus
                        placeholder="000000"
                        maxLength={6}
                        className="tracking-[0.3em]"
                        {...register("otp")}
                    />
                    {errors.otp ? (
                        <p className="text-sm text-destructive">
                            {errors.otp.message}
                        </p>
                    ) : null}
                </div>
                {errors.root ? (
                    <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                        {errors.root.message}
                    </p>
                ) : null}
                {resendMessage ? (
                    <p className="text-sm text-muted-foreground">
                        {resendMessage}
                    </p>
                ) : null}
                <Button
                    className="w-full"
                    type="submit"
                    disabled={isSubmitting}
                >
                    {isSubmitting ? "Verifying…" : "Verify & continue"}
                </Button>
            </form>
            <div className="mt-4 flex flex-col items-center gap-2 text-sm text-muted-foreground">
                <button
                    type="button"
                    className="font-medium text-foreground hover:underline disabled:opacity-50"
                    onClick={() => void onResend()}
                    disabled={resending}
                >
                    {resending ? "Sending…" : "Resend code"}
                </button>
                <button
                    type="button"
                    className="hover:text-foreground hover:underline"
                    onClick={onBack}
                >
                    Use a different email
                </button>
            </div>
        </div>
    )
}
