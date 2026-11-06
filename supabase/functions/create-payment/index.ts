// Crea el cobro de una sesión en Stripe y envía el email al paciente con Brevo.
// La app lo llama justo después de crear la cita: POST { session_id }
// Usa el token de la profesional, así RLS garantiza que solo cobra sesiones suyas.
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2025-02-24.acacia" });
const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const fmtFecha = (iso: string, tipo: string) => {
  const d = new Date(iso);
  const s = d.toLocaleString("es-ES", { timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  return s + (tipo === "Online" ? " (online)" : "");
};
const eur = (n: number) => n.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");
const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { session_id, reenviar } = await req.json();
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization")! } },
    });
    const { data: s, error } = await db.from("sessions").select("*, patients(*)").eq("id", session_id).single();
    if (error || !s) return json({ error: "Sesión no encontrada" }, 404);
    const p = s.patients;
    if (!p.email) return json({ error: "El paciente no tiene email" }, 400);
    if (s.pago_estado === "pagado") return json({ error: "Esta sesión ya está pagada" }, 409);

    const { data: cfg } = await db.from("settings").select("*").maybeSingle();
    const importe = Number(s.importe ?? p.tarifa);

    let url = s.pago_url as string | null;
    if (!url) {
      // Un enlace de pago por sesión: importe exacto, un solo uso, con el id de la sesión dentro
      const price = await stripe.prices.create({
        currency: "eur",
        unit_amount: Math.round(importe * 100),
        product_data: { name: `Sesión de psicoterapia ${new Date(s.fecha).toLocaleDateString("es-ES", { timeZone: "Europe/Madrid" })}` },
      });
      const link = await stripe.paymentLinks.create({
        line_items: [{ price: price.id, quantity: 1 }],
        restrictions: { completed_sessions: { limit: 1 } },
        metadata: { session_id: s.id, owner_id: s.owner_id },
        payment_intent_data: { metadata: { session_id: s.id } },
        after_completion: { type: "hosted_confirmation", hosted_confirmation: { custom_message: "Pago recibido. ¡Gracias! Nos vemos en la sesión." } },
      });
      url = `${link.url}?prefilled_email=${encodeURIComponent(p.email)}&client_reference_id=${s.id}`;
      await db.from("sessions").update({
        importe, pago_estado: "pendiente", pago_url: url, stripe_payment_link_id: link.id, stripe_price_id: price.id,
      }).eq("id", s.id);
    } else if (!reenviar && s.pago_email_enviado_at) {
      return json({ ok: true, url, ya_enviado: true });
    }

    // Email: solo fecha, importe y enlace. Nunca datos clínicos.
    const vars = { nombre: p.nombre.split(" ")[0], fecha: fmtFecha(s.fecha, s.tipo), importe: eur(importe), enlace: url };
    const texto = fill(cfg?.plantilla ?? "Hola {nombre}, puedes pagar tu sesión del {fecha} ({importe}) aquí: {enlace}", vars);
    const html = escHtml(texto).replace(escHtml(url), `<a href="${escHtml(url)}">Pagar ${escHtml(vars.importe)}</a>`).replace(/\n/g, "<br>");
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": Deno.env.get("BREVO_API_KEY")!, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { email: Deno.env.get("SENDER_EMAIL"), name: cfg?.nombre_consulta ?? Deno.env.get("SENDER_NAME") ?? "Consulta" },
        replyTo: cfg?.email_respuesta ? { email: cfg.email_respuesta } : undefined,
        to: [{ email: p.email, name: p.nombre }],
        subject: fill(cfg?.plantilla_asunto ?? "Tu sesión del {fecha}", vars),
        textContent: texto,
        htmlContent: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${html}</div>`,
      }),
    });
    if (!r.ok) return json({ error: "Stripe creado, pero el email no se pudo enviar", detalle: await r.text(), url }, 502);
    await db.from("sessions").update({ pago_email_enviado_at: new Date().toISOString() }).eq("id", s.id);
    return json({ ok: true, url });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
