// Creates a PENDING booking and a matching Razorpay order. The browser receives only the
// order ID and the public key ID; the key secret never leaves the server.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const bookingInput = z.object({
  guestName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().email().max(200),
  checkIn: z.string().date(),
  checkOut: z.string().date(),
  guests: z.number().int().min(1).max(20),
});

export const createBookingOrder = createServerFn({ method: "POST" })
  .inputValidator((input) => bookingInput.parse(input))
  .handler(async ({ data }) => {
    const checkIn = new Date(`${data.checkIn}T00:00:00Z`);
    const checkOut = new Date(`${data.checkOut}T00:00:00Z`);
    const nights = Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000);
    if (nights < 1) throw new Error("Check-out must be after check-in.");

    const keyId = process.env["RAZORPAY_KEY_ID"];
    const keySecret = process.env["RAZORPAY_KEY_SECRET"];
    if (!keyId || !keySecret) throw new Error("Razorpay credentials are not configured.");

    // Price is calculated on the server, so the browser can't change it.
    const amountPaise = nights * 1000 * 100;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: booking, error: insertError } = await supabaseAdmin
      .from("bookings")
      .insert({
        guest_name: data.guestName,
        phone: data.phone,
        email: data.email,
        check_in: data.checkIn,
        check_out: data.checkOut,
        guests: data.guests,
        nights,
        amount_paise: amountPaise,
        status: "PENDING",
      })
      .select("id, public_token")
      .single();
    if (insertError || !booking) throw new Error("Could not create the booking.");

    const authorization = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: `Basic ${authorization}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: amountPaise,
        currency: "INR",
        receipt: booking.id,
        notes: { booking_id: booking.id },
      }),
    });
    if (!response.ok) throw new Error("Razorpay could not create the order.");
    const order = (await response.json()) as { id: string };

    const { error: updateError } = await supabaseAdmin
      .from("bookings")
      .update({ razorpay_order_id: order.id })
      .eq("id", booking.id);
    if (updateError) throw new Error("Could not attach the payment order.");

    return {
      bookingToken: booking.public_token,
      orderId: order.id,
      keyId,
      amount: amountPaise,
      name: data.guestName,
      email: data.email,
      phone: data.phone,
    };
  });
