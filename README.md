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
