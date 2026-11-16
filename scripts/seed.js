// Crea un negocio (organización) con su administrador.
// Uso: npm run seed -- "Nombre del negocio" admin.usuario "Contraseña" "Nombre" "Apellido" 1065123456
require('dotenv').config()
const bcrypt = require('bcryptjs')
const supabase = require('../src/db')

const [businessName, username, password, name = 'Administrador', lastName = '', identification = '0000000'] = process.argv.slice(2)
if (!businessName || !username || !password) {
  console.error('Uso: npm run seed -- "Nombre del negocio" usuario "Contraseña" [Nombre] [Apellido] [Identificación]')
  process.exit(1)
}

;(async () => {
  const { data: org, error } = await supabase.from('organizations').insert({ name: businessName, status: 'activa' }).select().single()
  if (error) throw error
  await supabase.from('app_settings').insert({ org_id: org.id, business_name: businessName })
  const { error: e2 } = await supabase.from('users').insert({
    org_id: org.id, identification, name, last_name: lastName, username: username.toLowerCase(), role: 'administrador',
    password_hash: await bcrypt.hash(password, 10)
  })
  if (e2) throw e2
  console.log(`Negocio "${businessName}" (id ${org.id}) creado con el administrador ${username}`)
})().catch((e) => { console.error(e.message); process.exit(1) })
