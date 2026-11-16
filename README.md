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

## Despliegue
`render.yaml` define el servicio web para Render. Variables: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `JWT_SECRET`, `CORS_ORIGIN`.

## Ramas
`feature/KU-00X/Descripcion` o `fix/KU-00X/Descripcion` → `develop` (integración) → `main` (producción, solo con aprobación).
