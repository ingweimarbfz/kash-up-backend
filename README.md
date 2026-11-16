# KashUp · Backend

API de KashUp (cobros, préstamos y crédito de productos). Express + Supabase, multi-cliente por `org_id`.

## Arranque local
```bash
cp .env.example .env   # completar SUPABASE_SECRET_KEY y JWT_SECRET
npm install
npm run dev            # http://localhost:4000
```
La clave secreta está en Supabase → Project Settings → API Keys (proyecto `kash-up`).

## Estructura
```
src/
  index.js        arranque de Express y registro de rutas
  config.js       variables de entorno
  db.js           cliente de Supabase (tiempo límite y reintento en lecturas)
  tenant.js       multi-cliente: filtra y agrega org_id automáticamente
  auth.js         roles, sesión JWT y middleware auth(roles)
  audit.js        registro de auditoría
  http.js         errores, validaciones y utilidades
  routes/         auth, usuarios, configuración, dashboard, auditoría
supabase/migrations/   esquema de la base (aplicado en el proyecto kash-up)
scripts/seed.js        crea un negocio nuevo con su administrador
```

## Roles
| Rol | Alcance |
|---|---|
| `administrador` | Todo el negocio: configuración, usuarios, cartera y reportes |
| `prestamista` | Su ruta, sus clientes y sus cobros |
| `cliente` | Sus créditos, cuotas y pagos |

## Endpoints
| Método | Ruta | Rol |
|---|---|---|
| POST | `/login` | público |
| GET | `/auth/me` | todos |
| PUT | `/perfil` | todos |
| GET/POST/PUT | `/usuarios` | administrador |
| GET | `/configuracion` | todos |
| PUT | `/configuracion` | administrador |
| GET | `/dashboard` | todos (cifras según el rol) |
| GET | `/auditoria` | administrador |
| GET/POST/PUT | `/clientes`, `/clientes/:id` | administrador, prestamista (sus clientes) |
| POST | `/clientes/:id/usuario` | administrador (crea el acceso del cliente) |
| GET | `/prestamistas` | administrador, prestamista |
| GET/POST/PUT | `/tasas` | administrador (lectura: prestamista) |
| POST | `/simulador` | administrador, prestamista |
| GET/POST/PUT | `/inventario/categorias`, `/inventario/productos` | administrador (lectura: prestamista) |
| GET/POST/PUT | `/sedes`, `/inventario/bodegas` | administrador (lectura: prestamista) |
| GET | `/inventario/existencias?sede=&bodega=&categoria=&q=` | administrador, prestamista |
| GET/POST | `/inventario/movimientos` (entrada, ajuste, baja por bodega), GET `/inventario/resumen` | administrador |
| POST | `/inventario/traslados` (entre bodegas, número TR-0001) | administrador |
| GET/POST/PUT | `/descuentos` | administrador (lectura: prestamista) |
| POST | `/creditos/simular` | administrador, prestamista |
| GET/POST | `/creditos`, GET `/creditos/:id` | administrador, prestamista (los suyos) |
| POST | `/creditos/:id/anular` | administrador |
| GET | `/mis-creditos` | cliente |

## Capital y caja de los prestamistas

El administrador registra **aportes y retiros** de capital en la cuenta del negocio y desde ahí **asigna o quita**
dinero a cada prestamista (rutero). Un crédito en efectivo se desembolsa de la caja del prestamista que cobra
(o del negocio si no tiene prestamista); sin saldo suficiente el crédito no se crea, y si se anula el dinero vuelve
a la misma caja. La cuenta del negocio no puede bajar de la **reserva mínima** (por defecto 10 % del capital
aportado, configurable). Las reglas están en la base de datos (`apply_fund_movement`).

| Método | Ruta | Rol |
|---|---|---|
| GET | `/capital`, `/capital/movimientos?cuenta=negocio|<idPrestamista>` | administrador |
| POST | `/capital/aportes` (aporte o retiro), `/capital/asignaciones` (asignar o quitar) | administrador |
| PUT | `/capital/reserva` | administrador |
| GET | `/mi-caja` | prestamista |

## Pagos, abono a capital y renovación (etapa 3)

| Método | Ruta | Rol |
|---|---|---|
| POST | `/creditos/:id/pagos` (`kind`: cuota o abono_capital) | administrador, prestamista (sus créditos) |
| GET | `/pagos?desde=&hasta=&prestamista=&cliente=`, `/pagos/:id` (recibo) | administrador, prestamista |
| POST | `/pagos/:id/anular` (solo el último pago del crédito) | administrador |
| GET | `/creditos/:id/renovacion` | administrador, prestamista |
| GET | `/mis-pagos` | cliente |

- **Pago de cuota:** se aplica a las cuotas pendientes desde la más antigua. El efectivo entra a la caja del prestamista.
- **Abono a capital:** exige estar al día; paga el capital de las últimas cuotas hacia atrás y condona su interés (el plazo se acorta).
- **Renovación:** solo si el cliente está al día. El saldo actual del crédito se descuenta del nuevo y se entrega la diferencia;
  el crédito anterior queda `renovado`. Anular el crédito nuevo reactiva el anterior.
- **Un prestamista por cliente:** si el cliente ya tiene créditos con un prestamista, otro prestamista no le puede prestar; solo el administrador.

## Cobro: rutero, visitas, gastos, cierre, morosos y mapa (etapa 3)

- `GET /ruta?fecha=&prestamista=&todos=1`: cuotas que vencen ese día y las vencidas de los créditos activos del prestamista, en el orden de la ruta (`customers.route_order`), con lo cobrado y la visita del día. `PUT /ruta/orden` guarda el orden.
- `GET /rutas?fecha=` (administrador): avance de cada ruta, caja, gastos y si la jornada está cerrada.
- `POST /visitas`: visita sin pago (`no_pago`, `no_estaba`, `promesa` con fecha, `otro`) con ubicación.
- `GET /morosos?prestamista=&tramo=`: créditos en mora por antigüedad (1-7, 8-30, 31-60, 60+ días) con último pago y última visita.
- `GET /mapa`: clientes con ubicación y su estado (mora, al día, pagó hoy, sin crédito).
- `GET/POST /gastos`, `POST /gastos/:id/anular`: el gasto sale de la caja del prestamista (o del negocio) con `register_expense`; anular lo devuelve.
- `GET /cierres/resumen`, `POST /cierres`, `GET /cierres`, `DELETE /cierres/:id` (reabrir, administrador): `close_day` guarda el cuadre (esperado = saldo de la caja, contado, diferencia) y puede entregar efectivo al negocio. Con la jornada cerrada el prestamista no registra pagos ni gastos de ese día (trigger `check_day_open`).
- Los pagos por transferencia u otro medio entran a la cuenta del negocio; en efectivo, a la caja de quien cobra.

## Recibo de servicios y traslado de ruta

- El cliente nuevo exige la foto de un recibo de servicios (`utilityBillUrl`) para comprobar la dirección; sin recibo no se le puede prestar. `PUT /clientes/:id/recibo` lo sube a clientes antiguos.
- `POST /clientes/:id/traslado {lenderId, address?, neighborhood?, city?, lat?, lng?, utilityBillUrl?, note}`: el cliente pasa a la ruta de otro prestamista (y a su nueva dirección, con recibo nuevo). Sus créditos activos pasan a ese prestamista (`transfer_customer`), que desde ahí los cobra. Queda en `customer_transfers` y en la ficha del cliente. Cambiar el prestamista desde "Editar" hace lo mismo.
- Un prestamista solo presta a clientes de su ruta y sin créditos activos con otro prestamista (`check_credit_lender`).

## Reportes, dashboard y buscador (Etapa 4)

- `GET /reportes/recaudo|colocacion|resultados?desde&hasta&prestamista`: series por día (por mes si el rango pasa de 62 días), totales y desglose por prestamista. Por defecto el mes en curso; máximo un año.
- `GET /reportes/cartera?prestamista`: foto de hoy de la cartera activa, con cartera en riesgo (saldo de créditos con alguna cuota vencida / saldo total) y tramos de atraso (1-7, 8-30, 31-60, 60+).
- Los intereses cobrados salen de la parte de interés de cada cuota pagada (`interés de la cuota × lo abonado / valor de la cuota`). Los abonos a capital cuentan solo como capital.
- `GET /dashboard/extra`: recaudo de los últimos 14 días, salud de la cartera y, según el rol, avance de las rutas y mayores atrasos (admin) o promesas de pago y avance de la ruta (prestamista).
- `GET /buscar?q=`: busca a la vez clientes (nombre, cédula, celular), créditos, recibos (`RC-0003`), gastos (`GA-0002`), productos y usuarios. El prestamista solo ve lo suyo.

## Traslados de dinero y créditos adicionales (KU-014)

- **Traslado entre prestamistas:** el prestamista no le pasa dinero directo a otro. Desde "Mi caja" envía el valor al negocio (`POST /traslados-caja`) y queda pendiente. El administrador, en "Capital y cajas", lo entrega al prestamista pedido o a otro, o lo devuelve (`POST /traslados-caja/:id/entregar|rechazar`). Los movimientos son del tipo `traslado` y no consumen la reserva mínima del negocio.
- **Varios créditos por cliente:** si el prestamista crea un crédito (que no sea renovación) para un cliente que ya tiene uno activo, se guarda como solicitud (`credit_requests`, número `SC-0001`) y responde 202. El administrador la aprueba en "Solicitudes" y el crédito se crea con fecha de hoy desde la caja del prestamista. La base de datos lo exige con el trigger `check_credit_lender`. El administrador puede crear créditos adicionales directamente.

## Inventario por bodegas

Cada negocio tiene una **bodega principal** (en su sede principal) y puede crear sedes y varias bodegas por sede.
Las existencias se llevan por bodega en `warehouse_stock`; `products.stock` es el total de todas. Cada movimiento
(entrada, ajuste, baja, entrega en crédito, devolución o traslado) indica su bodega, y si una bodega quedara en
negativo la operación completa se cancela con un mensaje claro. El crédito de producto entrega desde la bodega
elegida y su anulación devuelve los productos a esa misma bodega. Los productos exigen categoría.

## Cálculo de créditos (`src/lib/schedule.js`)
| Modalidad | Cómo se calcula |
|---|---|
| `fija` | Interés plano: capital × tasa × meses de plazo (o × 1 si la tasa es por todo el crédito). Cuotas iguales. |
| `sobre_saldo` | Cuota fija con interés sobre el saldo (sistema francés). La tasa mensual se lleva al periodo de la cuota. |
| `anticipada` | El interés se descuenta al desembolsar; las cuotas solo pagan capital. |

Periodicidad diaria, semanal, quincenal, mensual o cada N días, con opción de excluir domingos. `npm test` corre las pruebas del cálculo y del scoring.

## Despliegue
`render.yaml` define el servicio web para Render. Variables: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `JWT_SECRET`, `CORS_ORIGIN`.

## Ramas
`feature/KU-00X/Descripcion` o `fix/KU-00X/Descripcion` → `develop` (integración) → `main` (producción, solo con aprobación).
