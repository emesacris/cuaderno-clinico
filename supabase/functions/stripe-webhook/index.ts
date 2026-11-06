// Stripe llama aquí cuando un paciente paga. Marca la sesión como pagada y crea la factura cobrada.
// Desplegar con --no-verify-jwt (Stripe no envía token de Supabase; la seguridad es la firma de Stripe).
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2025-02-24.acacia" });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig!, Deno.env.get("STRIPE_WEBHOOK_SECRET")!);
  } catch {
    return new Response("Firma no válida", { status: 400 });
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const cs = event.data.object as Stripe.Checkout.Session;
    if (cs.payment_status !== "paid") return new Response("pendiente", { status: 200 });
    const linkId = typeof cs.payment_link === "string" ? cs.payment_link : cs.payment_link?.id;
    const q = admin.from("sessions").select("*, patients(nombre)");
    const { data: s } = linkId ? await q.eq("stripe_payment_link_id", linkId).maybeSingle()
                               : await q.eq("id", cs.client_reference_id ?? "").maybeSingle();
    if (!s) return new Response("sesión no encontrada", { status: 200 });
    if (s.pago_estado === "pagado") return new Response("ya registrado", { status: 200 }); // Stripe puede repetir el aviso

    let invoiceId = s.invoice_id;
    if (!invoiceId) {
      const { data: num } = await admin.rpc("next_invoice_num", { p_owner: s.owner_id });
      const { data: inv, error } = await admin.from("invoices").insert({
        owner_id: s.owner_id, patient_id: s.patient_id, session_id: s.id, num,
        concepto: `Sesión de psicoterapia (${new Date(s.fecha).toLocaleDateString("es-ES", { timeZone: "Europe/Madrid" })})`,
        importe: (cs.amount_total ?? 0) / 100, pagada: true, stripe_checkout_id: cs.id,
      }).select("id").single();
      if (error) return new Response("error factura: " + error.message, { status: 500 }); // Stripe reintentará
      invoiceId = inv.id;
    } else {
      await admin.from("invoices").update({ pagada: true, stripe_checkout_id: cs.id }).eq("id", invoiceId);
    }
    await admin.from("sessions").update({ pago_estado: "pagado", pagado_at: new Date().toISOString(), invoice_id: invoiceId }).eq("id", s.id);
  }

  if (event.type === "checkout.session.async_payment_failed") {
    const cs = event.data.object as Stripe.Checkout.Session;
    const linkId = typeof cs.payment_link === "string" ? cs.payment_link : cs.payment_link?.id;
    if (linkId) await admin.from("sessions").update({ pago_estado: "fallido" }).eq("stripe_payment_link_id", linkId);
  }
  return new Response("ok", { status: 200 });
});
