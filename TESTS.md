# Pool de pruebas - ML Panel

## Cómo usar
Recorrer cada sección, marcar ✅ si funciona, ❌ si falla, anotar el error.

---

## 1. AUTENTICACIÓN
- [ ] Login con usuario/contraseña (admin/admin123)
- [ ] Login con Google OAuth (alpuy.mateo@gmail.com)
- [ ] Crear usuario nuevo desde Usuarios
- [ ] Cerrar sesión y re-login
- [ ] Usuario sin permiso no puede acceder a admin
- [ ] Rate limit: 20+ intentos seguidos bloquea 15 min

## 2. DASHBOARD VENTAS
- [ ] Carga KPIs (facturación, órdenes, pagadas, canceladas)
- [ ] Gráfico mensual se muestra
- [ ] Cambiar período (hoy, semana, mes)
- [ ] Últimas órdenes se listan

## 3. ÓRDENES ML
- [ ] Lista de órdenes carga con paginación
- [ ] Filtro por estado funciona
- [ ] Búsqueda por comprador/ID funciona

## 4. STOCK ML
- [ ] Lista de publicaciones carga
- [ ] Filtro por estado (activa, pausada)
- [ ] Búsqueda por SKU/nombre
- [ ] Muestra incoming (mercadería en camino)

## 5. STOCK ODOO
- [ ] Carga productos desde cache
- [ ] Filtro por categoría
- [ ] Filtro ABC por canal (ML, Mayorista, Local)
- [ ] Filtro sin stock / bajo / alto
- [ ] Búsqueda por SKU/nombre
- [ ] Agrupar por categoría funciona
- [ ] Mostrar/ocultar packs

## 6. ORDEN SUGERIDA
### Filtros
- [ ] "Con faltante" muestra solo productos con gap > 0
- [ ] "Todos los productos" muestra todos (ej: buscar 75140 con stock 75)
- [ ] "Sin stock" filtra correctamente
- [ ] "Quiebre" muestra solo will_break
- [ ] "Zafral" muestra productos zafral
- [ ] Filtro ABC (A/B/C) funciona
- [ ] Filtro XYZ (X/Y/Z) funciona
- [ ] Filtro Origen (China/Brasil) funciona
- [ ] Filtro Categoría muestra categorías de Odoo
- [ ] Búsqueda por número (21) busca por inicio de SKU
- [ ] Búsqueda por texto (lampara) busca en nombre
- [ ] Checkbox "Incluir pedidos" oculta/muestra items ya en carrito

### Ordenamiento
- [ ] Mayor faltante
- [ ] Mayor facturación
- [ ] Mayor venta/mes
- [ ] ABC prioridad
- [ ] Por categoría (agrupa por categoría Odoo)

### Productos
- [ ] Cada producto muestra foto (ML o Odoo fallback)
- [ ] Muestra badge canal principal (ML, Local, Mayorista, WhatsApp)
- [ ] Muestra CBM total del gap (violeta) o "SIN CBM" (rojo)
- [ ] Click en producto expande detalle con ventas por canal/mes
- [ ] Detalle muestra costo, precio, margen, valor stock
- [ ] Tabla ventas por canal: ML, Local, Mayorista, WhatsApp, Total
- [ ] Productos MDF excluidos
- [ ] Productos "estantes" excluidos
- [ ] Packs excluidos
- [ ] Productos agrupados por SKU base (variantes color juntas)

### Cálculo gap
- [ ] Gap = (90d cobertura × venta_diaria × 1.3) - stock_al_llegar
- [ ] stock_al_llegar = max(stock + incoming + pedido - venta_diaria × lead_time, 0)
- [ ] Promedio divide por meses CON ventas (no por 6)
- [ ] Producto sin ventas 3 meses no se sugiere
- [ ] Lead time China 120d, Brasil 30d

### Carrito
- [ ] Agregar producto con "+" / "+ Pedir"
- [ ] Producto agregado muestra "✓ Agregado" en verde
- [ ] Agregar SKU manual funciona
- [ ] Cambiar cantidad en carrito
- [ ] Eliminar del carrito (✕)
- [ ] Muestra CBM total y FOB total
- [ ] Muestra FOB/unidad por item
- [ ] Indica "(X sin FOB)" si hay items sin precio
- [ ] "Guardar pedido" guarda como orden preparada
- [ ] "Excel" genera archivo descargable
- [ ] "Contenedores" calcula distribución CBM
- [ ] "Limpiar" vacía el carrito

### Órdenes preparadas
- [ ] Se muestra la sección "Órdenes preparadas"
- [ ] Botón "Editar" carga items al carrito
- [ ] Botón "Excel" descarga con precios
- [ ] Botón "Sin precios" descarga sin FOB
- [ ] Botón "Pedida" marca como pedida con fecha
- [ ] Eliminar orden funciona
- [ ] Badge azul en productos muestra en qué orden está

## 7. MIS ÓRDENES DE COMPRA
- [ ] Carga KPIs (total, pedidas, confirmadas, inversión)
- [ ] Draft en progreso muestra "Continuar editando"
- [ ] Tabla de órdenes muestra todas
- [ ] Click en orden expande detalle con items
- [ ] Cambiar cantidad de item se guarda
- [ ] Agregar item por SKU funciona
- [ ] Eliminar item funciona
- [ ] Botón "Con precios" genera Excel con FOB
- [ ] Botón "Sin precios" genera Excel sin FOB
- [ ] Botón "Editar" carga al carrito
- [ ] Botón "Confirmar" cambia estado
- [ ] Eliminar orden funciona

## 8. PREVISIONES
- [ ] Carga reglas de previsión
- [ ] Tabla de productos con forecast

## 9. ESTRATEGIA ML
- [ ] Carga datos de publicación (precio, stock, visitas)
- [ ] Simulador de rentabilidad calcula correctamente
- [ ] Cambiar costo/TACOS recalcula tabla
- [ ] Botón "Aplicar precio" (requiere permisos ML)
- [ ] Botón "Activar envío gratis" (requiere permisos ML)
- [ ] Botón "Iniciar plan" ejecuta precio + envío
- [ ] Historial de cambios muestra log
- [ ] Snapshots horarios se registran
- [ ] Link a publicación ML funciona

## 10. NOTEBOOK
- [ ] Escribir consulta y recibir respuesta
- [ ] Tabla se genera correctamente
- [ ] Gráfica (Chart.js) se renderiza
- [ ] Historial de conversación funciona
- [ ] "Limpiar" resetea todo

## 11. CATÁLOGO MAYORISTA
- [ ] Carga productos desde cache Odoo
- [ ] Filtro por categoría
- [ ] Filtro con/sin stock
- [ ] Búsqueda por nombre/SKU
- [ ] Vista lista y grilla
- [ ] Descargar PDF

## 12. PREGUNTAS ML
- [ ] Carga preguntas pendientes
- [ ] Simular respuesta con IA
- [ ] Responder pregunta

## 13. IMPORTACIONES
- [ ] Dashboard Drive carga
- [ ] Buscar importaciones
- [ ] Leer PI con IA

## 14. SINCRONIZACIÓN ODOO
- [ ] Botón "Sincronizar" en Usuarios muestra barra progreso
- [ ] Log en tiempo real (consola negra)
- [ ] Muestra última actualización con fecha
- [ ] Se pone rojo si >24h sin actualizar
- [ ] Push a Railway funciona
- [ ] Railway no conecta a Odoo directamente
- [ ] Refresh incremental (solo cambios)

## 15. SEGURIDAD
- [ ] Helmet headers presentes (check con DevTools → Network)
- [ ] HTTPS redirect en Railway
- [ ] Rate limit funciona en login
- [ ] Sesiones expiran a los 30 días
- [ ] Usuarios sin rol admin no ven sección Usuarios
- [ ] Emails autorizados Google se gestionan desde Usuarios

## 16. RESPONSIVE
- [ ] Sidebar se colapsa en mobile
- [ ] KPIs se reorganizan (4 → 2 → 1 col)
- [ ] Tablas tienen scroll horizontal
- [ ] Carrito es usable en mobile

---

## Notas de errores encontrados
(Anotar acá los bugs encontrados durante las pruebas)

