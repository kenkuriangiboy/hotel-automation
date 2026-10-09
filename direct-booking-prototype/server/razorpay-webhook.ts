// Razorpay webhook handler: the only place a booking becomes CONFIRMED.
// Route: POST /api/razorpay-webhook (TanStack Start server route, built with Lovable)
// Secrets are read from server-side environment variables; none are stored in code.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const capturedEvent = z.object({
  event: z.string(),
  payload: z.object({
    payment: z.object({
      entity: z.object({ id: z.string(), order_id: z.string() }),
    }),
  }),
});

export const Route = createFileRoute("/api/razorpay-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // 1. Verify the request really comes from Razorpay (HMAC-SHA256 of the raw body).
        const secret = process.env["RAZORPAY_WEBHOOK_SECRET"];
        if (!secret) return new Response("Webhook is not configured", { status: 503 });
        const signature = request.headers.get("x-razorpay-signature") ?? "";
        const body = await request.text();
        const expected = createHmac("sha256", secret).update(body).digest("hex");
        const receivedBuffer = Buffer.from(signature, "utf8");
        const expectedBuffer = Buffer.from(expected, "utf8");
        if (receivedBuffer.length !== expectedBuffer.length || !timingSafeEqual(receivedBuffer, expectedBuffer)) {
          return new Response("Invalid signature", { status: 401 });
        }

        // 2. Validate the payload and act only on captured payments.
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          return new Response("Invalid payload", { status: 400 });
        }
        const parsed = capturedEvent.safeParse(payload);
        if (!parsed.success) return new Response("Invalid payload", { status: 400 });
        if (parsed.data.event !== "payment.captured") return new Response("Ignored", { status: 200 });

        // 3. Confirm the matching PENDING booking.
        const payment = parsed.data.payload.payment.entity;
        const confirmedAt = new Date().toISOString();
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: booking, error } = await supabaseAdmin
          .from("bookings")
          .update({
            status: "CONFIRMED",
            razorpay_payment_id: payment.id,
            confirmed_at: confirmedAt,
            confirmation_webhook_sent_at: confirmedAt,
          })
          .eq("razorpay_order_id", payment.order_id)
          .eq("status", "PENDING")
          .select("id, guest_name, email, phone, check_in, check_out, guests, amount_paise")
          .maybeSingle();
        if (error) return new Response("Update failed", { status: 500 });

        // A duplicate Razorpay delivery finds no PENDING row, so n8n is not called twice.
        if (!booking) return new Response("ok");

        // 4. Hand off to n8n for the confirmation email. A failure here never un-confirms a paid booking.
        const n8nUrl = process.env["N8N_CONFIRMATION_WEBHOOK_URL"];
        if (!n8nUrl) {
          console.error(`[n8n] Confirmation webhook URL is not configured for booking ${booking.id}.`);
          return new Response("ok");
        }
        try {
          const n8nResponse = await fetch(n8nUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              guest_name: booking.guest_name,
              email: booking.email,
              phone: booking.phone,
              check_in: booking.check_in,
              check_out: booking.check_out,
              guests: booking.guests,
              amount: booking.amount_paise / 100,
              payment_id: payment.id,
              booking_id: booking.id,
            }),
          });
          if (!n8nResponse.ok) {
            console.error(`[n8n] Confirmation webhook failed for booking ${booking.id} with status ${n8nResponse.status}.`);
          }
        } catch (caught) {
          console.error(`[n8n] Confirmation webhook request failed for booking ${booking.id}.`, caught);
        }

        return new Response("ok");
      },
    },
  },
});
