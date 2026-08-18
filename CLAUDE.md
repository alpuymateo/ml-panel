# ML Panel — Rentabilidad por Orden

## Qué es este proyecto
Sistema web interno de MA IMPORTACIONES para gestionar ventas de MercadoLibre Uruguay. Corre en un servidor en Digital Ocean (68.183.134.24) con Node.js + Express + SQLite (better-sqlite3).

## Arquitectura
- **ml-panel** (este repo): frontend + algunos endpoints de rentabilidad. Puerto 3000 en DO.
- **ml-atencion** (repo hermano): backend principal con sync ML/Odoo/Shopify, envíos DAC/SD, etiquetas. Puerto 3001 en DO.
- **Base de datos**: SQLite en `data/panel.db` (compartida). Schema en `db.js`.
- **Deploy**: PM2 en DO. Para subir cambios: `scp archivo root@68.183.134.24:/root/ml-panel/archivo` y `ssh root@68.183.134.24 "pm2 restart ml-panel"`.

## Tu scope: ordenes.html
Tu trabajo principal es mantener y arreglar `public/ordenes.html` — la página de Rentabilidad por Orden.

### Archivos que podés tocar
- `public/ordenes.html` — frontend de rentabilidad (HTML + JS inline)
- `index.js` — endpoints bajo `/api/rentabilidad/*`
- `db.js` — solo si necesitás agregar una columna o tabla

### Archivos que NO debés tocar
- Todo lo de sync (sync.js, crons)
- Shopify, DAC, SD, etiquetas
- Otras páginas HTML (stock.html, me1.html, despachos.html, arenal.html, etc.)
- Variables de entorno (.env)

## Cómo funciona ordenes.html

### Frontend
- Filtros: fecha desde/hasta, búsqueda SKU/producto/orden, checkboxes (sin costo, sospechosas)
- Vista "Por orden": lista de ventas ML con rentabilidad desglosada
- Vista "Por publicación": ranking de publicaciones por facturación
- Modal de detalle al hacer click en una orden
- Botón "Problema": abre modal para reportar problemas con una orden

### Backend (endpoints en index.js)
- `GET /api/rentabilidad/ordenes?from=&to=` — devuelve órdenes con rentabilidad calculada
- `GET /api/rentabilidad/ranking?from=&to=` — ranking por publicación
- `GET /api/rentabilidad/publicacion/:itemId` — detalle de una publicación
- `GET /api/rentabilidad/verificar/:orderId` — verificar datos contra API ML
- `POST /api/rentabilidad/cost-override` — guardar costo manual de un SKU
- `GET /api/problemas` — listar problemas pendientes
- `POST /api/problemas` — crear problema
- `POST /api/problemas/:id/resolver` — marcar como resuelto

### Cálculo de rentabilidad (IMPORTANTE)
Cada orden se calcula así:
- **Venta**: total_amount de la orden
- **Costo**: standard_price de Odoo × 1.22 (con IVA). Se busca en `odoo_products` por SKU. Si no encuentra exacto, prueba sin variante (15904-NEG → 15904). Override manual en tabla `cost_overrides`.
- **Comisión**: marketplace_fee de ML
- **Envío**: depende del tipo:
  - `self_service` (Flex): cadete $131 (roperos $450). ML te pasa sender_save.
  - `drop_off` (ME): gratis, sin costo cadete.
  - `default` (ME1/DAC): cadete default $900. Override por SKU en `cost_overrides.dac_cost`. ML te pasa sender_save.
- **Publicidad**: se estima como % de venta (configurable, default 5%)
- **Margen** = Venta - Costo - Comisión - (Cadete - EnvíoML) - Publicidad

### Tablas relevantes (db.js)
- `ml_orders` — órdenes ML (id, status, total_amount, marketplace_fee, buyer, dates)
- `ml_order_items` — items de cada orden (item_sku, seller_custom_field, unit_price, quantity)
- `ml_shipments` — envíos (logistic_type, sender_cost, sender_save, receiver_cost)
- `odoo_products` — productos Odoo (default_code=SKU, standard_price=costo, qty_available=stock)
- `cost_overrides` — costos manuales por SKU (sku, cost, dac_cost)
- `problemas` — problemas reportados (order_id, descripcion, estado)

### Costos DAC especiales (ya configurados)
- Espejos (302xx): $300
- Cunas (38023): $300
- Juegos de comedor (139xx, 140xx): $305 (250+IVA)
- Default mueble: $900

## Moneda
Todo en pesos uruguayos (UYU). Todos los costos incluyen IVA (×1.22).

## Cómo probar
1. Editar el archivo localmente
2. `scp public/ordenes.html root@68.183.134.24:/root/ml-panel/public/ordenes.html`
3. Si tocaste index.js: `scp index.js root@68.183.134.24:/root/ml-panel/index.js && ssh root@68.183.134.24 "pm2 restart ml-panel"`
4. Verificar en: https://predisastrously-techier-fisher.ngrok-free.dev/ordenes.html

## Reglas
- NUNCA escribir en Odoo. Solo lectura.
- Todos los montos con IVA incluido.
- No agregar features nuevas sin que Mateo lo pida.
- Si algo no funciona, primero verificar que el dato existe en la DB antes de cambiar código.
