# Fluffy Master · versión web (Supabase)

La misma app que usas en Claude, pero en tu propio link:

- Cada persona entra con su correo y contraseña.
- Los datos quedan en tu base de datos de Supabase, protegidos por rol.
- No hace falta cuenta de Claude.

## Qué hay en esta carpeta

| Archivo | Para qué |
|---|---|
| `index.html` | La app |
| `config.js` | Aquí van los datos de tu proyecto de Supabase |
| `vendor/` | Librerías de la app (Supabase, Excel y PDF), incluidas para no depender de otros sitios |
| `supabase/schema.sql` | Crea las tablas y la seguridad en Supabase |
| `.gitignore` | Evita que los datos de clientas se suban a GitHub |

Los datos para la primera carga vienen **aparte**, en `fluffy-master-migracion.zip`. Ese archivo tiene nombres de clientas y números del negocio: **no lo subas a GitHub ni lo compartas**.

---

## Paso 1 · Crear las cuentas

Crea las tres cuentas con un correo de Fluffy (por ejemplo, admin@fluffylashesco.com), para que el negocio sea dueño de todo:

1. **Supabase** (supabase.com): base de datos y logins.
2. **GitHub** (github.com): guarda el código.
3. **Netlify** (netlify.com) o **Cloudflare Pages** (pages.cloudflare.com): publica la app en internet.

Antes de elegir el plan de hosting, revisa en su página de precios que el plan gratuito permita uso comercial.

## Paso 2 · Crear la base de datos en Supabase

1. En Supabase, toca **New project**. Ponle de nombre `fluffy-master`, elige la región **East US** y guarda la contraseña de la base en un lugar seguro.
2. Cuando el proyecto esté listo, ve a **SQL Editor → New query**.
3. Abre `supabase/schema.sql`, copia **todo** su contenido, pégalo y toca **Run**. Debe decir *Success*.
4. En una consulta nueva, pega esta línea con **tu** correo y tu nombre, y toca **Run**:

   ```sql
   insert into public.members (email, name, role) values ('tu-correo@ejemplo.com', 'Amy', 'admin');
   ```

   El correo va en minúsculas.
5. Copia dos datos de tu proyecto:
   - **Project URL**: está en el botón **Connect** arriba del panel, o en **Project Settings → Data API**. Se ve así: `https://abcdefgh.supabase.co`.
   - **Publishable key**: está en **Project Settings → API Keys**. Empieza con `sb_publishable_`. Si ahí ves un botón **Create new API keys**, tócalo primero. Si tu proyecto muestra la pestaña **Legacy API Keys**, también sirve la llave **anon**, que empieza con `eyJ`.
6. Abre `config.js` con un editor de texto y pega esos dos datos donde dice `TU-PROYECTO` y `PEGA-AQUI…`. Guarda el archivo.

La *publishable key* (o *anon*) puede ir en `config.js` sin problema: la seguridad la ponen las reglas de la base (RLS), no esa llave. La que **nunca** debes poner ahí es la **secret key** (`sb_secret_…`) ni la *service_role*.

## Paso 3 · Subir el código a GitHub

1. En GitHub, toca **New repository**. Ponle de nombre `fluffy-master` y márcalo como **Private**. Toca **Create repository**.
2. Toca **uploading an existing file**.
3. Arrastra todo el contenido de esta carpeta: `index.html`, `config.js`, `README.md`, `.gitignore` y las carpetas `vendor` y `supabase`.
4. Toca **Commit changes**.

## Paso 4 · Publicar la app

**Con Netlify:**

1. Toca **Add new site → Import an existing project → GitHub** y autoriza el acceso.
2. Elige el repositorio `fluffy-master`.
3. Deja **Build command** vacío y en **Publish directory** escribe `.` (un punto).
4. Toca **Deploy**. Al terminar te da un link, por ejemplo `https://fluffy-master.netlify.app`. En Netlify puedes cambiar el nombre o conectar un dominio propio.

**Con Cloudflare Pages:** elige *Connect to Git*, el mismo repositorio, sin comando de build y con directorio de salida `/`.

## Paso 5 · Conectar el link con Supabase

Así funcionan los correos de confirmación y de "olvidé mi contraseña":

1. En Supabase, ve a **Authentication → URL Configuration**.
2. En **Site URL** pega el link de tu app.
3. En **Redirect URLs** agrega el mismo link y toca **Save**.

## Paso 6 · Primera entrada y carga de datos

1. Abre el link de tu app y toca **Crear mi contraseña** con el correo que pusiste en el Paso 2.
2. Confirma tu cuenta con el correo que te llega y entra con tu contraseña.
3. Como es la primera vez, aparece **Cargar datos iniciales**. Descomprime `fluffy-master-migracion.zip` y elige:
   - `historico.json`: las ventas y gastos del Excel, metas y notas de insumos.
   - `datos-de-claude.json`: lo que ya se guardó en la versión de Claude (gastos de septiembre, claves, configuración, ventas y citas).
4. Toca **Cargar**. Al terminar se abre el Dashboard con todo tu histórico.

**Haz el cambio de un día para otro.** El respaldo tiene lo que estaba guardado en la versión de Claude el 8 de octubre de 2026. Si después de esa fecha se registra algo más allá, hay que exportarlo de nuevo antes de cargarlo.

## Paso 7 · Dar acceso al equipo

1. En la app, ve a **Configuración → Usuarios → Agregar usuario**: nombre, correo y rol.
2. Esa persona abre el link, toca **Crear mi contraseña** con ese correo y confirma su cuenta.

| Rol | Qué puede hacer |
|---|---|
| Administración | Todo, incluidos usuarios y claves |
| Edición | Todo menos usuarios y claves |
| Recepción | Siempre en modo recepción: agenda, cobrar, depósitos, paquetes, insumos y notas del día |
| Solo lectura | Ver sin guardar |

Estos permisos los aplica la base de datos. Aunque alguien intente saltarse la pantalla, Supabase rechaza lo que su rol no permite.

**Quitar acceso:** en Configuración → Usuarios, toca **Quitar acceso**.

## Paso 8 · El iPad

1. Abre el link en **Safari** y entra con la cuenta de recepción.
2. Toca el botón de compartir y luego **Agregar a pantalla de inicio**.
3. Úsalo en horizontal para ver el menú completo.

Si en el iPad usan una sola cuenta de recepción para varias personas, cada una toca **Cambiar de turno** y entra con su clave personal. Las claves se crean en Configuración → Claves de edición.

## Respaldos y mantenimiento

- **Respaldos:** el plan gratuito de Supabase no hace respaldos automáticos. Para datos financieros conviene el plan Pro. Mientras tanto, descarga cada semana los reportes en Excel desde Reportes.
- **Pausa por inactividad:** en el plan gratuito, Supabase pausa el proyecto si pasa una semana sin uso. Con uso diario no pasa; si ocurre, se reactiva desde el panel de Supabase.
- **Actualizar la app:** cuando haya una versión nueva, sube el `index.html` nuevo al repositorio en GitHub (*Add file → Upload files*). Netlify o Cloudflare la publican sola en un par de minutos.
- **Nunca subas** a GitHub la carpeta `migracion` ni la *secret key*.
