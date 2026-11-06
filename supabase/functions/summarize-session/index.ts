// Resume con IA (Claude, de Anthropic) la nota clínica de una sesión y guarda el resumen en la sesión.
// La app lo llama con el token de la profesional: POST { session_id }. RLS garantiza que solo lee sesiones suyas.
// Privacidad: a la IA NO se envían nombre, email, teléfono ni fecha de nacimiento; solo edad, motivo,
// diagnóstico de trabajo, riesgos registrados y el texto de las notas.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "jsr:@supabase/supabase-js@2";

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
const MODEL = Deno.env.get("SUMMARY_MODEL") ?? "claude-opus-5-5";
const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fecha = (iso: string) => new Date(iso).toLocaleDateString("es-ES", { timeZone: "Europe/Madrid", day: "numeric", month: "long", year: "numeric" });
const edad = (iso?: string | null) => {
  if (!iso) return "edad no registrada";
  const b = new Date(iso), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--;
  return `${a} años`;
};

const SYSTEM = `Eres asistente de una psicóloga sanitaria (España) especializada en trauma y trastornos de la conducta alimentaria. Resumes la nota clínica de una sesión para la historia clínica.
Responde en español, en texto plano, con exactamente estos apartados y nada más:
RESUMEN (2-3 frases)
TEMAS CLAVE (viñetas con "- ")
INTERVENCIÓN REALIZADA (viñetas)
EVOLUCIÓN RESPECTO A LA SESIÓN ANTERIOR (1-2 frases; si no hay sesión anterior, dilo)
ALERTAS O RIESGOS (viñetas; si no hay, escribe "- Ninguna indicada en la nota")
TAREAS ACORDADAS (viñetas)
No inventes información que no esté en la nota. No hagas diagnósticos nuevos.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { session_id } = await req.json();
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization")! } },
    });
    const { data: s, error } = await db.from("sessions")
      .select("id, patient_id, fecha, tipo, nota_temas, nota_intervencion, nota_observaciones, nota_plan, patients(nacimiento, motivo, dx, riesgo)")
      .eq("id", session_id).single();
    if (error || !s) return json({ error: "Sesión no encontrada" }, 404);
    if (!s.nota_temas && !s.nota_intervencion && !s.nota_observaciones) return json({ error: "Escribe primero la nota de la sesión" }, 400);
    const p: any = s.patients;

    const { data: prev } = await db.from("sessions")
      .select("fecha, nota_temas, nota_observaciones, nota_plan")
      .eq("patient_id", s.patient_id).eq("estado", "realizada").neq("id", s.id).lt("fecha", s.fecha)
      .order("fecha", { ascending: false }).limit(1).maybeSingle();

    const prompt = `Paciente: ${edad(p?.nacimiento)}. Motivo: ${p?.motivo ?? "-"}. Diagnóstico de trabajo: ${p?.dx ?? "-"}. Riesgos registrados: ${p?.riesgo || "ninguno"}.
Fecha de la sesión: ${fecha(s.fecha)}. Modalidad: ${s.tipo}.

NOTA DE ESTA SESIÓN
Temas tratados: ${s.nota_temas ?? ""}
Intervención: ${s.nota_intervencion ?? ""}
Observaciones clínicas: ${s.nota_observaciones ?? ""}
Plan / tareas: ${s.nota_plan ?? ""}

${prev ? `NOTA DE LA SESIÓN ANTERIOR (${fecha(prev.fecha)})
Temas: ${prev.nota_temas ?? ""}
Observaciones: ${prev.nota_observaciones ?? ""}
Plan: ${prev.nota_plan ?? ""}` : "No hay sesión anterior registrada."}`;

    // Los modelos Opus admiten un modelo de respaldo si el filtro de seguridad rechaza la petición
    const params: any = {
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: prompt }],
    };
    if (MODEL.startsWith("claude-opus")) { params.betas = ["server-side-fallback-2026-07-01"]; params.fallbacks = "default"; }
    const msg = await anthropic.beta.messages.create(params);
    if (msg.stop_reason === "refusal") return json({ error: "La IA no ha podido resumir esta nota. Resúmela a mano." }, 422);
    const texto = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    if (!texto) return json({ error: "La IA no devolvió texto. Vuelve a intentarlo." }, 502);

    const ahora = new Date().toISOString();
    await db.from("sessions").update({ resumen: texto, resumen_fecha: ahora }).eq("id", s.id);
    return json({ texto, fecha: ahora });
  } catch (e) {
    const err = e as any;
    if (err?.status === 401) return json({ error: "Falta la clave de la IA o no es válida (ANTHROPIC_API_KEY)." }, 500);
    if (err?.status === 429) return json({ error: "Demasiadas peticiones seguidas. Espera un minuto y vuelve a probar." }, 429);
    if (err?.status === 400 && /credit/i.test(String(err?.message))) return json({ error: "No queda saldo en la cuenta de IA. Recarga saldo en Anthropic." }, 402);
    return json({ error: "No se pudo generar el resumen. Vuelve a intentarlo." }, 500);
  }
});
