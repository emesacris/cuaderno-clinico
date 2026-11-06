// Envía un email de recordatorio a cada paciente con cita en las próximas 24 horas.
// Lo ejecuta Supabase Cron cada hora. Cada cita se recuerda una sola vez.
import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const fmtFecha = (iso: string, tipo: string) =>
  new Date(iso).toLocaleString("es-ES", { timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) +
  (tipo === "Online" ? " (online)" : "");
const eur = (n: number) => n.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");
const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// Solo puede lanzarlo quien tenga la clave secreta del proyecto (el cron de Supabase la envía)
const clavesValidas = (): string[] => {
  const v = [Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""];
  try { v.push(...Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>)); } catch { /* sin claves nuevas */ }
  return v.filter(Boolean);
};

Deno.serve(async (req) => {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "") || (req.headers.get("apikey") ?? "");
  if (!token || !clavesValidas().includes(token)) return new Response("No autorizado", { status: 401 });
  const now = Date.now();
  const desde = new Date(now + 2 * 3600e3).toISOString();   // no recordar citas que empiezan en menos de 2 h
  const hasta = new Date(now + 24 * 3600e3).toISOString();
  const { data: citas, error } = await admin.from("sessions")
    .select("id, owner_id, fecha, tipo, importe, pago_estado, pago_url, patients(nombre, email, tarifa)")
    .eq("estado", "programada").is("recordatorio_enviado_at", null)
    .gte("fecha", desde).lte("fecha", hasta);
  if (error) return new Response(error.message, { status: 500 });

  const cfgs = new Map<string, any>();
  let enviados = 0, omitidos = 0;
  for (const s of citas ?? []) {
    const p: any = s.patients;
    if (!cfgs.has(s.owner_id)) {
      const { data } = await admin.from("settings").select("*").eq("owner_id", s.owner_id).maybeSingle();
      cfgs.set(s.owner_id, data);
    }
    const cfg = cfgs.get(s.owner_id);
    if (!p?.email || cfg?.recordatorio_activo === false) { omitidos++; continue; }

    // Reservar la cita antes de enviar, para no mandar dos recordatorios si el cron coincide
    const { data: claimed } = await admin.from("sessions").update({ recordatorio_enviado_at: new Date().toISOString() })
      .eq("id", s.id).is("recordatorio_enviado_at", null).select("id");
    if (!claimed?.length) continue;

    const vars = { nombre: p.nombre.split(" ")[0], fecha: fmtFecha(s.fecha, s.tipo), importe: eur(Number(s.importe ?? p.tarifa)), enlace: s.pago_url ?? "" };
    let texto = fill(cfg?.recordatorio_plantilla ?? "Hola {nombre}, te recuerdo que tenemos sesión el {fecha}.", vars);
    if (s.pago_estado === "pendiente" && s.pago_url && !texto.includes(s.pago_url)) {
      texto += `\n\nTodavía tienes pendiente el pago (${vars.importe}). Puedes hacerlo aquí:\n${s.pago_url}`;
    }
    let html = escHtml(texto).replace(/\n/g, "<br>");
    if (s.pago_url) html = html.replace(escHtml(s.pago_url), `<a href="${escHtml(s.pago_url)}">Pagar ${escHtml(vars.importe)}</a>`);
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": Deno.env.get("BREVO_API_KEY")!, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { email: Deno.env.get("SENDER_EMAIL"), name: cfg?.nombre_consulta ?? Deno.env.get("SENDER_NAME") ?? "Consulta" },
        replyTo: cfg?.email_respuesta ? { email: cfg.email_respuesta } : undefined,
        to: [{ email: p.email, name: p.nombre }],
        subject: fill(cfg?.recordatorio_asunto ?? "Recordatorio: tu sesión del {fecha}", vars),
        textContent: texto,
        htmlContent: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${html}</div>`,
      }),
    });
    if (r.ok) enviados++;
    else { // liberar para reintentar en la próxima hora
      await admin.from("sessions").update({ recordatorio_enviado_at: null }).eq("id", s.id);
      console.error("Brevo", r.status, await r.text());
    }
  }
  return new Response(JSON.stringify({ revisadas: citas?.length ?? 0, enviados, omitidos }), { headers: { "Content-Type": "application/json" } });
});
