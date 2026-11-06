// Resume con IA (Claude, de Anthropic) una sesión y lo guarda en ella.
// La app lo llama con el token de la profesional. RLS garantiza que solo lee sesiones suyas.
//  - POST { session_id }: resume la nota escrita.
//  - POST { session_id, transcripcion }: con la transcripción de la grabación (hecha en el ordenador de la
//    profesional; el audio nunca sale de allí) redacta la nota (temas, intervención, observaciones, plan) y el resumen.
//    La transcripción no se guarda.
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

const SYSTEM_TRANSCRIPCION = `Eres asistente de una psicóloga sanitaria (España) especializada en trauma y trastornos de la conducta alimentaria.
Recibes la transcripción automática de una sesión de psicoterapia. No indica quién habla: deduce por el contexto qué dice la psicóloga y qué dice el/la paciente. Puede contener errores de reconocimiento de voz; interprétalos con prudencia.
Redacta en español, en tercera persona y con lenguaje clínico, la nota de la sesión para la historia clínica:
- temas: temas tratados por el/la paciente.
- intervencion: técnicas e intervenciones de la psicóloga.
- observaciones: observaciones clínicas relevantes (estado emocional, cambios, alianza, y cualquier indicio de riesgo: autolesión, ideación suicida, conductas purgativas, restricción grave...). Si no hay indicios de riesgo, dilo.
- plan: tareas acordadas y plan para próximas sesiones.
- resumen: texto plano con exactamente estos apartados: RESUMEN (2-3 frases), TEMAS CLAVE (viñetas con "- "), INTERVENCIÓN REALIZADA (viñetas), EVOLUCIÓN RESPECTO A LA SESIÓN ANTERIOR (1-2 frases; si no hay sesión anterior, dilo), ALERTAS O RIESGOS (viñetas; si no hay, "- Ninguna detectada"), TAREAS ACORDADAS (viñetas).
No inventes nada que no esté en la transcripción. No hagas diagnósticos nuevos. No copies frases literales largas ni incluyas nombres de terceras personas: usa su relación (madre, pareja...).`;

const ESQUEMA = {
  type: "object",
  properties: {
    temas: { type: "string" }, intervencion: { type: "string" }, observaciones: { type: "string" },
    plan: { type: "string" }, resumen: { type: "string" },
  },
  required: ["temas", "intervencion", "observaciones", "plan", "resumen"],
  additionalProperties: false,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { session_id, transcripcion } = await req.json();
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization")! } },
    });
    const { data: s, error } = await db.from("sessions")
      .select("id, patient_id, fecha, tipo, nota_temas, nota_intervencion, nota_observaciones, nota_plan, patients(nacimiento, motivo, dx, riesgo)")
      .eq("id", session_id).single();
    if (error || !s) return json({ error: "Sesión no encontrada" }, 404);
    const conTranscripcion = typeof transcripcion === "string" && transcripcion.trim().length > 0;
    if (!conTranscripcion && !s.nota_temas && !s.nota_intervencion && !s.nota_observaciones) return json({ error: "Escribe primero la nota de la sesión" }, 400);
    const p: any = s.patients;

    const { data: prev } = await db.from("sessions")
      .select("fecha, nota_temas, nota_observaciones, nota_plan")
      .eq("patient_id", s.patient_id).eq("estado", "realizada").neq("id", s.id).lt("fecha", s.fecha)
      .order("fecha", { ascending: false }).limit(1).maybeSingle();

    const contexto = `Paciente: ${edad(p?.nacimiento)}. Motivo: ${p?.motivo ?? "-"}. Diagnóstico de trabajo: ${p?.dx ?? "-"}. Riesgos registrados: ${p?.riesgo || "ninguno"}.
Fecha de la sesión: ${fecha(s.fecha)}. Modalidad: ${s.tipo}.`;
    const anterior = prev ? `NOTA DE LA SESIÓN ANTERIOR (${fecha(prev.fecha)})
Temas: ${prev.nota_temas ?? ""}
Observaciones: ${prev.nota_observaciones ?? ""}
Plan: ${prev.nota_plan ?? ""}` : "No hay sesión anterior registrada.";
    const prompt = conTranscripcion
      ? `${contexto}\n\n${anterior}\n\nTRANSCRIPCIÓN DE ESTA SESIÓN\n${transcripcion.slice(0, 400000)}`
      : `${contexto}

NOTA DE ESTA SESIÓN
Temas tratados: ${s.nota_temas ?? ""}
Intervención: ${s.nota_intervencion ?? ""}
Observaciones clínicas: ${s.nota_observaciones ?? ""}
Plan / tareas: ${s.nota_plan ?? ""}

${anterior}`;

    // Los modelos Opus admiten un modelo de respaldo si el filtro de seguridad rechaza la petición
    const params: any = {
      model: MODEL,
      max_tokens: 16000,
      system: conTranscripcion ? SYSTEM_TRANSCRIPCION : SYSTEM,
      output_config: conTranscripcion ? { effort: "medium", format: { type: "json_schema", schema: ESQUEMA } } : { effort: "medium" },
      messages: [{ role: "user", content: prompt }],
    };
    if (MODEL.startsWith("claude-opus")) { params.betas = ["server-side-fallback-2026-07-01"]; params.fallbacks = "default"; }
    const msg = await anthropic.beta.messages.create(params);
    if (msg.stop_reason === "refusal") return json({ error: "La IA no ha podido resumir esta nota. Resúmela a mano." }, 422);
    const texto = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    if (!texto) return json({ error: "La IA no devolvió texto. Vuelve a intentarlo." }, 502);

    const ahora = new Date().toISOString();
    if (conTranscripcion) {
      let n: Record<string, string>;
      try { n = JSON.parse(texto); } catch { return json({ error: "La IA devolvió un formato inesperado. Vuelve a intentarlo." }, 502); }
      // Si ya había algo escrito en un apartado, se conserva y se añade debajo lo generado
      const junta = (antes: string | null, nuevo: string) => (antes?.trim() ? `${antes.trim()}\n\n${nuevo}` : nuevo);
      const fila = {
        estado: "realizada",
        nota_temas: junta(s.nota_temas, n.temas), nota_intervencion: junta(s.nota_intervencion, n.intervencion),
        nota_observaciones: junta(s.nota_observaciones, n.observaciones), nota_plan: junta(s.nota_plan, n.plan),
        resumen: n.resumen, resumen_fecha: ahora,
      };
      await db.from("sessions").update(fila).eq("id", s.id);
      return json({ texto: n.resumen, fecha: ahora, nota: { temas: fila.nota_temas, intervencion: fila.nota_intervencion, observaciones: fila.nota_observaciones, plan: fila.nota_plan } });
    }
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
