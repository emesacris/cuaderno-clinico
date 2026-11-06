# Cuaderno Clínico

Gestión de pacientes para consulta de psicología sanitaria: agenda, fichas, notas de sesión, facturación y cobro automático con Stripe.

## Cómo funciona el cobro automático

1. Creas una cita. La app llama a la función `create-payment`.
2. Esa función crea en Stripe un enlace de pago de un solo uso por el importe de la sesión y envía el email al paciente con Brevo. El email solo lleva fecha, importe y enlace, nunca datos clínicos.
3. El paciente paga. Stripe avisa a la función `stripe-webhook`, que marca la sesión como pagada y crea la factura cobrada.
4. La app lo ve en tiempo real y te avisa con "X ha pagado su sesión".

## Estructura

- `supabase/migrations/0001_init.sql`: tablas, reglas de acceso (RLS) y numeración de facturas.
- `supabase/functions/create-payment`: crea el cobro y envía el email.
- `supabase/functions/stripe-webhook`: recibe la confirmación de pago de Stripe.
- `index.html` y `config.js`: la app, que es una página estática publicada con GitHub Pages.

## Puesta en marcha

### 1. Supabase (región UE)
1. Crea un proyecto en https://supabase.com con la región **Central EU (Frankfurt)**.
2. En Authentication → Providers → Email, desactiva **Allow new users to sign up**. Así nadie más puede registrarse.
3. En Authentication → Users → Add user, crea tu usuaria con una contraseña de al menos 12 caracteres.
4. Aplica la base de datos con `supabase link --project-ref <ref>` y después `supabase db push`.

### 2. Stripe
1. Activa la cuenta con tus datos fiscales.
2. Ve a Developers → API keys y copia la **Secret key**.
3. Ve a Developers → Webhooks → Add endpoint con la URL `https://<ref>.supabase.co/functions/v1/stripe-webhook`. Elige los eventos `checkout.session.completed`, `checkout.session.async_payment_succeeded` y `checkout.session.async_payment_failed`. Copia el **Signing secret**.

### 3. Brevo
1. Crea la cuenta y verifica el email remitente en Senders, o mejor tu dominio.
2. Ve a SMTP & API → API Keys y crea una clave.

### 4. Secretos y despliegue de funciones
```
supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_... \
  BREVO_API_KEY=xkeysib-... SENDER_EMAIL=consulta@tudominio.es SENDER_NAME="Consulta" \
  APP_ORIGIN=https://<tu-usuario>.github.io
supabase functions deploy create-payment
supabase functions deploy stripe-webhook --no-verify-jwt
```

### 5. La app
1. Rellena `config.js` con la URL del proyecto y la anon key, que están en Project Settings → API.
2. Publica el repositorio con GitHub Pages (Settings → Pages → rama main).
3. Añade esa URL en Supabase, en Authentication → URL Configuration, para que funcione "He olvidado mi contraseña".

Haz las pruebas primero con las claves de **modo prueba** de Stripe (`sk_test_...`) y la tarjeta 4242 4242 4242 4242.

## Seguridad y RGPD
- Los datos se guardan en la UE (Frankfurt) y están cifrados en reposo y en tránsito.
- RLS: cada cuenta solo puede leer y escribir sus propios datos.
- La sesión se cierra tras 30 minutos sin actividad.
- Firma el DPA (acuerdo de encargado del tratamiento) de Supabase, Stripe y Brevo. Los tres lo ofrecen desde su panel.
- Copias de seguridad: el plan Pro de Supabase hace copias diarias. En el plan gratuito, exporta tú los datos con regularidad.
