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

## Endpoints (etapa 1)
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
| GET/POST | `/inventario/movimientos`, GET `/inventario/resumen` | administrador |
| GET/POST/PUT | `/descuentos` | administrador (lectura: prestamista) |
| POST | `/creditos/simular` | administrador, prestamista |
| GET/POST | `/creditos`, GET `/creditos/:id` | administrador, prestamista (los suyos) |
| POST | `/creditos/:id/anular` | administrador |
| GET | `/mis-creditos` | cliente |

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
