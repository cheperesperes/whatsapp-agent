# Marketing Reviewer Approval Checklist (Luz)

**Usa este checklist ANTES de aprobar cualquier campaña generada por Luz.**
Cada casilla debe estar marcada con ✅. Si alguna falla, marca ❌ y usa el botón 🔄 Regenerar en el dashboard — NO aproveces por excepción.

---

## 1. Cumplimiento Legal (§3.1)

- [ ] **Sin lenguaje político.** No menciona gobierno, régimen, partido, dictador, embargo, "el sistema".
- [ ] **Sin promesas de Cuba sin OFAC.** Nada de "garantizado a Cuba", "envío 100% asegurado a La Habana".
- [ ] **Disclosure SCP presente.** Si el post menciona Cuba (envío/destino/entrega), incluye *"Envíos a Cuba operan bajo 15 CFR §740.21 – License Exception SCP."* en FB, IG y YouTube description.
- [ ] **Sin mención de usuarios finales prohibidos.** No apunta a entidades del gobierno cubano, militares o listas restrictivas.

## 2. Integridad de Claims (§3.2)

- [ ] **Specs coinciden con el catálogo.** Wh, Ah, W, ciclos, autonomía — todos deben aparecer en `agent_product_catalog` o en la ficha oficial del fabricante. Si no están en la DB, NO deben estar en el post.
- [ ] **Precios verificados.** `sell_price` y `cuba_total_price` deben coincidir con lo que ves en la DB *hoy*.
- [ ] **Sin urgencia falsa.** No hay "últimas X unidades", "solo hoy", "quedan 3", contadores de tiempo.
- [ ] **Sin testimonios inventados.** No hay citas de clientes, reseñas de 5 estrellas, ni "juanito de Miami dice...".
- [ ] **Competidores (si aplica).** Si se menciona Bluetti/EcoFlow/Jackery, la comparación está respaldada por datos reales y no es despectiva.

## 3. Honestidad y Alcance (§3.3)

- [ ] **Sin consejo restringido.** No incluye instrucciones de instalación eléctrica, cableado, configuración de inversores, ni consejo médico/legal/fiscal.
- [ ] **Sin garantías fuera de control.** No promete tiempos de aduana cubana, ahorros exactos en factura, ni resultados que dependan de terceros.

## 4. Privacidad (§3.4)

- [ ] **Sin datos personales.** El copy no expone emails, teléfonos, nombres o direcciones de clientes reales.
- [ ] **Email/SMS cumplen CAN-SPAM/TCPA.** Si se va a enviar a lista, el footer incluye opt-out (STOP/PARE) y dirección física de Oiikon.

## 5. Voz de Marca y Cultura (§3.5)

- [ ] **Sin culpar al lector.** No usa "tú estás aquí", "tú desde aquí", "mientras ellos sufren", "sintiéndote impotente", "tú cómodo".
- [ ] **Sin explotar sufrimiento.** El apagón/huracán se menciona como contexto breve, no como dramatización extendida para presionar.
- [ ] **Tono respetuoso.** Cálido, educado, optimista. Ningún sarcasmo o humor que pueda malinterpretarse.
- [ ] **Español natural.** Sin frases calcadas del inglés, sin errores gramaticales, tildes correctas.

## 6. IP y Disclosure de IA (§3.6)

- [ ] **Disclosure de IA presente.** "🤖 Contenido creado con IA, revisado por humanos." aparece en FB e IG.
- [ ] **Sin copyright ajeno.** No incluye letras de canciones, logos de competidores, imágenes que no sean de Oiikon.
- [ ] **Si hay imagen/video con personas generado por IA:** etiqueta apropiada según la plataforma (Meta, TikTok).

## 7. Reglas por Canal (§3.7)

- [ ] **Google Ads headlines** — cada uno ≤ 30 caracteres (ya enforced por código, pero verifica).
- [ ] **Google Ads descriptions** — cada una ≤ 90 caracteres.
- [ ] **WhatsApp broadcast** — solo se enviará a contactos opt-in; plantilla aprobada por Meta si es promo.
- [ ] **Links funcionan.** El link `oiikon.com/product/<sku>` abre la ficha correcta y el producto tiene stock.

## 8. Sentido Común

- [ ] **El producto del día tiene sentido.** ¿Está en stock? ¿Precio actual? ¿No es un discontinuado?
- [ ] **El tema del día es apropiado.** No coincide con una tragedia nacional reciente que hiciera ver mal lanzar campaña solar hoy.
- [ ] **El contenido se lee completo y natural.** No hay frases cortadas, JSON roto, placeholders tipo `{{product}}`.

---

## Acción

**Si TODAS las casillas están ✅:**
Aprobar en dashboard → click "✅ Publicar ahora" (o responder `SI` por WhatsApp si llega el preview).

**Si alguna casilla está ❌:**
Click "🔄 Regenerar campaña" en dashboard y vuelve a revisar. Si falla 3 veces con el mismo issue, documenta el caso y reporta a Eduardo para que ajuste el system prompt.

**Si una casilla te deja dudas (compliance ambiguo, producto confuso):**
Escala al oficial de compliance OFAC/BIS antes de publicar. NO aproveces "por las dudas".

---

## Registro de Aprobación

Al aprobar, el sistema registra automáticamente:
- `campaign_id` — identificador único
- `approved_by` — email/usuario que aprobó
- `approved_at` — timestamp
- Estado final: `published` o `rejected`

El log queda disponible para auditoría de compliance.

---

**Versión:** 1.0 | **Vinculado al Código de Conducta v2.0**
