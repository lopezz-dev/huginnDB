# Conector MCP de HuginnDB

> Nota: este archivo es la traducción al español de `MCP.md`. Si ves algo
> desactualizado respecto al original en inglés, ese es el que manda.

`huginndb-mcp` es un servidor headless de [Model Context Protocol](https://modelcontextprotocol.io)
que expone las bases de datos que HuginnDB ya conoce — los perfiles de
`profiles.json`, con las contraseñas leídas del llavero del sistema — a un
cliente MCP como Claude Code, Claude Desktop, Cursor, Antigravity o Codex. El
asistente puede entonces inspeccionar el estado *real* de tus bases de datos
(esquema, filas de ejemplo, recuentos de filas, versión del servidor,
privilegios) en lugar de adivinar.

Al ser un servidor MCP estándar sobre stdio sin código específico por
cliente, **cualquier** cliente MCP compatible con la especificación puede
usarlo — las secciones de abajo cubren los que tienen particularidades de
configuración que merece la pena documentar; cualquier otro que hable MCP (el
agente integrado de un editor, un harness a medida, …) funciona igual en
cuanto le indiques la ruta al binario.

Es un proceso **separado**. Por defecto abre sus propios *pools* de forma
perezosa, bajo demanda, y solo para las conexiones que expongas explícitamente:
no comparte los de la app de escritorio en ejecución. *Puede* compartirlos si
activas **Ajustes → Conexiones → Compartir pools con el conector MCP**, lo que
da a toda la máquina un único presupuesto de conexiones por servidor; ver
[Compartir los pools de la app](#compartir-los-pools-de-la-app). Cada conexión
expuesta tiene un **nivel de escritura** — `read-only` (por defecto), `data` o
`full` — configurado por conexión en **Ajustes → MCP**; las lecturas siempre
funcionan, y las escrituras solo se ejecutan si el nivel de esa conexión lo
permite. Ver [Seguridad](#seguridad).

Consulta [`MCP_CONNECTOR_ROADMAP.md`](MCP_CONNECTOR_ROADMAP.md) para el
razonamiento de diseño (en inglés).

## Primeros pasos

Cuatro pasos, una sola vez. Nada de esto necesita una terminal salvo que
quieras usarla.

**1. Instala HuginnDB.** El conector viaja dentro del instalador como binario
sidecar — no hay nada más que descargar ni nada que compilar.

**2. Elige a qué puede llegar el asistente.** Abre **Ajustes → MCP** y marca
las conexiones que quieras que vea. **Nada es alcanzable hasta que lo marcas**,
y esa es toda la decisión de acceso: la configuración del cliente de IA no
nombra ninguna conexión.

**3. Elige qué puede hacer.** Cada conexión marcada tiene un nivel de escritura
en el mismo panel:

| Nivel | Qué permite |
| --- | --- |
| `read-only` *(por defecto)* | Solo lecturas. Toda herramienta de escritura se rechaza. |
| `data` | Añade `INSERT` / `UPDATE` / `DELETE`. Sin cambios de esquema. |
| `full` | Añade `CREATE` / `DROP` / `ALTER`, vistas e índices. |

Déjalo todo en `read-only` hasta que tengas un motivo para no hacerlo. Tanto
esto como el paso 2 se releen en **cada llamada**, así que puedes cambiar de
opinión después sin reiniciar nada. Lo mismo vale para la propia conexión: si
la editas en HuginnDB (otra base de datos, host o usuario), la siguiente
llamada del conector usa los datos nuevos. Si esa conexión está abierta en la
app con el *bridge* activado, el conector te pide que la reconectes allí
primero, en vez de cerrarla por debajo de tus pestañas.

**4. Apunta tu cliente al conector.**

- **Claude Code** — pulsa **Añadir a Claude Code** en Ajustes → MCP. Ese es
  todo el paso. (Ejecuta `claude mcp add` por ti; ver
  [Claude Code (CLI)](#claude-code-cli) para hacerlo a mano.)
- **Claude Desktop** — descarga el `.mcpb` del
  [último release](https://github.com/Alexfp28/huginnDB/releases) y suéltalo en
  **Ajustes → Extensiones**. Ver
  [Claude Desktop (extensión de un clic)](#claude-desktop-extensión-de-un-clic).
- **Cualquier otro** — copia el snippet JSON de Ajustes → MCP a la
  configuración de tu cliente. Lleva una ruta y nada más, así que es el mismo
  en cualquier máquina y se pega una sola vez.

**Comprueba que funciona.** Pídele al asistente: *"con huginndb, lista mis
conexiones, luego lista las tablas de \<nombre\> y enséñame 5 filas de la
primera."* Si responde con nombres de tabla reales, ya está.

### Si vienes de una configuración anterior a la 1.21

Tu configuración actual sigue funcionando exactamente igual — no hay que hacer
nada. Pero conviene saber qué cambió, porque la forma antigua ya no es la
buena.

Las conexiones expuestas vivían en la configuración del propio cliente como
`--connections <uuid>,<uuid>`, y por eso añadir una conexión obligaba a editar
ese fichero (uno por cliente) y reiniciarlo. Esa lista ahora vive en la app, en
el paso 2 de arriba.

**Un cliente lanzado con `--connections` queda fijado a esa lista** e ignora
las casillas, a propósito: un argumento que escribiste tú manda sobre una
casilla, en los dos sentidos. Para pasar un cliente a las casillas, quita el
flag de su configuración — el comando se queda en una ruta pelada — y marca lo
que quieras en Ajustes → MCP. Para dejar un cliente deliberadamente más
estrecho que el resto, deja el flag; ver [Fijar un cliente a un conjunto
concreto](#fijar-un-cliente-a-un-conjunto-concreto).

Un cambio de comportamiento que conviene conocer: `run_query` ya no acepta
sentencias que escriban. Esas van por `run_write`, y el rechazo lo dice.

## Obtener el binario

**Instalaciones empaquetadas (el caso normal):** `huginndb-mcp` se distribuye
como *sidecar* de Tauri, instalado justo al lado del ejecutable principal —
nada que compilar. Abre **Ajustes → MCP** en la app: muestra la ruta
resuelta, te deja elegir qué conexiones guardadas exponer, y genera
configuración lista para pegar en Claude Code / Claude Desktop / otros
clientes. El resto de este documento es la referencia de lo que ofrece ese
panel, más los clientes para los que no genera una plantilla (Codex).

**AppImage en Linux.** Un AppImage se ejecuta desde un montaje temporal
(`/tmp/.mount_Huginn…`) que cambia de nombre en cada arranque y se elimina al
cerrar la app, así que el *sidecar* que lleva dentro no tiene una ruta que un
cliente pueda guardar. Desde un AppImage, Ajustes → MCP da por eso el propio
archivo `.AppImage` más el argumento `--mcp`, que arranca el conector dentro
de la imagen:

```bash
claude mcp add huginndb -s user -- /ruta/a/HuginnDB.AppImage --mcp
```

```json
{ "mcpServers": { "huginndb": { "command": "/ruta/a/HuginnDB.AppImage", "args": ["--mcp"] } } }
```

Esa ruta sobrevive a reinicios y a las actualizaciones desde la app (que
sustituyen el archivo en su sitio). Mover o renombrar el `.AppImage` la rompe,
como a cualquier ruta; Ajustes → MCP muestra entonces el registro como
desfasado y ofrece **Actualizar registro** (ver [Claude Code](#claude-code-cli)).
Cualquier otro argumento que
pases (`--connections`, `--read-only`, …) va detrás de `--mcp`.

**Mantenerse al día sin abrir la app.** En Windows, HuginnDB instala las
versiones nuevas en segundo plano: una tarea programada comprueba al iniciar
sesión y otra una vez al día, e instala sin avisar con el mismo feed firmado
que usa la app. El conector se actualiza con ella, incluido el de la extensión
de Claude Desktop, que cede sus sesiones a esta copia. Espera mientras HuginnDB
está abierto, y la comprobación diaria también espera mientras un cliente de IA
tiene el conector en marcha; la de inicio de sesión instala igualmente, así que
si un cliente pierde el conector después, reinícialo. En Ajustes → Acerca de →
**Actualizaciones en segundo plano** se desactiva y se ve qué mecanismo está
funcionando en el equipo; si el administrador del dominio prohíbe las tareas
programadas, recurre a una entrada de inicio, y si también la prohíbe, lo dice
y deja las actualizaciones al botón de la app. Si una actualización lleva más
de un día esperando, las instrucciones del conector lo dicen y la herramienta de
IA lo transmite; el conector lo sabe por lo que registró la app y nunca
consulta el feed de actualizaciones por su cuenta. `huginndb.exe --update` hace
la misma comprobación a mano.

**Compilar desde el código fuente (solo desarrollo):** el conector vive en su
propio crate del workspace (`src-tauri/mcp-server/`), fuera del `Cargo.toml`
de la app de escritorio para que un `pnpm tauri:build` normal nunca lo
compile ni lo empaquete por su cuenta (ver el gotcha del `[[bin]]` múltiple
de tauri-bundler en `CLAUDE.md` para el porqué; el workflow de release lo
prepara aparte como sidecar). Compílalo explícitamente:

```bash
cd src-tauri
cargo build --release -p huginndb-mcp
# binario en: src-tauri/target/release/huginndb-mcp[.exe]
```

## Configurar un cliente

Cada cliente apunta a la **ruta absoluta** del conector — consíguela en
Ajustes → MCP en una instalación empaquetada, o mira [Obtener el
binario](#obtener-el-binario) para una compilación desde fuente (en Windows,
`…\target\release\huginndb-mcp.exe`).

**A qué conexiones puede llegar se elige en la app**, no en la configuración
del cliente: abre **Ajustes → MCP** y márcalas. El conector relee esa elección
de `profiles.json` en cada llamada, así que exponer una conexión más es marcar
una casilla — sin editar configuración ni reiniciar el cliente. Nada queda
expuesto hasta que lo marcas.

Por eso ninguna de las plantillas de abajo lleva un id de conexión: son las
mismas en cualquier máquina y se pegan una sola vez. (Antes de 1.21 el conjunto
expuesto vivía aquí como `--connections <uuid>,<uuid>`; esas configuraciones
siguen funcionando — ver [Fijar un cliente a un conjunto
concreto](#fijar-un-cliente-a-un-conjunto-concreto).)

**Cómo nombrar una conexión en un prompt.** Cada herramienta acepta el
**nombre** de la conexión tal y como aparece en HuginnDB — *"con huginndb, lista
las tablas de Producción MySQL"* — o su id de perfil. `list_connections`
devuelve ambos. Los nombres se comparan sin distinguir mayúsculas; si dos
conexiones expuestas comparten uno, el conector lo dice y pide el id en vez de
adivinar.

### Claude Code (CLI)

**Ajustes → MCP tiene un botón "Añadir a Claude Code"** que ejecuta esto
mismo por ti, si el CLI `claude` está en tu `PATH`. Pulsarlo dos veces es
inofensivo — informa de que ya estaba registrado en vez de fallar. Para
deshacerlo, `claude mcp remove huginndb`.

El panel también lee qué tiene registrado Claude Code como `huginndb` (de
`~/.claude.json`, o `$CLAUDE_CONFIG_DIR/.claude.json`; nunca ejecuta el CLI
solo para mirar). Cuando ese registro es este conector pero con un comando que
esta instalación ya no usa (un AppImage registrado por una versión anterior, que
apuntaba a un montaje temporal, o una instalación que se movió), lo dice y
ofrece **Actualizar registro**. Eso ejecuta `claude mcp remove huginndb -s
user` y después el `add` de arriba, conservando los argumentos que hubieras
añadido (`--connections`, `--read-only`, …); si el `add` falla, se restaura
la entrada anterior. Otro servidor que casualmente se llame `huginndb` se
muestra y se deja como está.

Lo mismo a mano:

```bash
claude mcp add huginndb -s user -- /ruta/absoluta/a/huginndb-mcp
```

- El `--` separa el comando+args del servidor de los flags propios de
  `claude`.
- `-s user` lo deja disponible en todos los proyectos; usa `-s local` (el
  valor por defecto) solo para el repo actual.
- Compruébalo con `/mcp` dentro de una sesión, y luego prueba *"con huginndb,
  lista las tablas de `<nombre>` y muéstrame 5 filas de la primera"*.

Configuración equivalente escrita a mano (`~/.claude.json`, o un `.mcp.json`
de proyecto):

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "/ruta/absoluta/a/huginndb-mcp",
      "args": []
    }
  }
}
```

### Claude Desktop (extensión de un clic)

Cada release adjunta un **MCP Bundle** — `huginndb-mcp-<versión>-win32.mcpb`
(y uno `-linux`) en la
[página de releases](https://github.com/Alexfp28/huginnDB/releases).
Descárgalo y abre **Ajustes → Extensiones** en Claude Desktop: arrastra el
fichero o usa *Instalar extensión*. Ni ruta que copiar ni JSON que editar.

El bundle lleva su propia copia del conector, pero no es autónomo:
**HuginnDB tiene que estar instalado en la misma máquina**, porque ahí es donde
viven los perfiles de conexión y sus entradas del llavero. Qué conexiones puede
alcanzar sigue siendo Ajustes → MCP en la app, y se sigue releyendo en cada
llamada — la extensión no tiene ajustes propios, que es justo la gracia.

**La extensión se instala una vez; las actualizaciones llegan con la app.** En
Windows, la copia del bundle cede la sesión al conector instalado junto a
`huginndb.exe` (lo localiza por la clave de desinstalación del instalador y, si
no, en `%LOCALAPPDATA%\HuginnDB\`), así que actualizar HuginnDB actualiza lo que
ejecuta Claude Desktop, incluida la política gestionada que ese conector aplica.
La copia propia del bundle solo sirve la sesión cuando no encuentra una
instalada. `HUGINNDB_MCP_PATH` apunta a otra copia instalada o, definida pero
vacía, desactiva el traspaso.

Usa la vía manual de abajo si quieres fijar un cliente a un subconjunto con
`--connections`, que el bundle no pasa.

### Claude Desktop (manual)

Ajustes → Developer → **Edit Config** abre `claude_desktop_config.json`
(`%APPDATA%\Claude\` en Windows, `~/Library/Application Support/Claude/` en
macOS). Añade el servidor y **reinicia la app**:

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "C:\\ruta\\a\\huginndb-mcp.exe",
      "args": []
    }
  }
}
```

En Windows, duplica las barras invertidas en la ruta JSON (`\\`).

### Cursor

Cursor lee los servidores MCP de un `mcp.json` con la misma forma
`mcpServers` que Claude Desktop — bien `.cursor/mcp.json` en la raíz de un
proyecto (limitado a ese proyecto) o `~/.cursor/mcp.json` (global, todos los
proyectos):

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "/ruta/absoluta/a/huginndb-mcp",
      "args": []
    }
  }
}
```

También puedes añadirlo desde la UI de Ajustes → MCP de Cursor ("Add new
global MCP server") si prefieres no editar el archivo a mano. De cualquier
forma, el snippet JSON que genera Ajustes → MCP en la app se pega tal cual.

### Antigravity (Google)

Antigravity — el IDE agéntico de Google potenciado por Gemini — usa la misma
forma `mcpServers`/`command`/`args`. En vez de buscar el archivo de
configuración (su ubicación ha cambiado entre versiones de Antigravity),
añade el servidor desde la UI: **panel del Agente → menú "…" → MCP Servers →
Manage MCP Servers → View raw config**, y pega:

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "/ruta/absoluta/a/huginndb-mcp",
      "args": []
    }
  }
}
```

Guarda y pulsa refrescar en la lista de Installed MCP Servers. (La única
diferencia real de Antigravity frente a Cursor/Claude Desktop está en los
servidores remotos por HTTP, que usan `serverUrl` en vez de
`command`/`args` — no aplica aquí, ya que `huginndb-mcp` es un proceso local
sobre stdio.)

### Codex CLI

Codex lee los servidores MCP de `~/.codex/config.toml` (TOML, no el JSON de
Claude). Añade una tabla `[mcp_servers.<nombre>]`:

```toml
[mcp_servers.huginndb]
command = "C:\\ruta\\a\\huginndb-mcp.exe"
args = []
# opcional: startup_timeout_sec = 20
```

O añádelo desde la CLI (los servidores stdio toman un comando separado por
`--`):

```bash
codex mcp add huginndb -- /ruta/absoluta/a/huginndb-mcp
```

Las herramientas aparecen entonces bajo el servidor `huginndb` dentro de
Codex.

## Flags de línea de comandos

| Flag | Por defecto | Significado |
| --- | --- | --- |
| `--connections <a,b,c>` | *(ninguna)* | Fija este cliente exactamente a estos IDs de perfil, ignorando las casillas de Ajustes → MCP. Sin el flag, el servidor se remite a esas casillas y las relee en cada llamada, que es el montaje normal. `--connections ""` fija un conjunto vacío — un "no expongas nada" explícito. |
| `--max-rows <n>` | `1000` | Límite superior de filas devueltas por una llamada a `run_query` / `run_write` / `browse_table`, para que una llamada no vuelque una tabla entera en el contexto del modelo. |
| `--read-only[=true\|false]` | `false` | Kill-switch global: fuerza **todas** las conexiones a solo lectura sin importar su nivel de escritura guardado. Una forma rápida de exponer el conector en modo garantizado-seguro sin tocar ningún perfil. |
| `--allow-writes` | — | **Obsoleto e ignorado.** Las escrituras ahora se gobiernan por conexión mediante el nivel de escritura configurado en Ajustes → MCP (ver [Seguridad](#seguridad)); este flag ya no concede nada y solo imprime un aviso de obsolescencia. |

Los flags aceptan tanto `--flag valor` como `--flag=valor`.

### Fijar un cliente a un conjunto concreto

`--connections id1,id2` sobreescribe las casillas de Ajustes → MCP solo para ese
cliente, durante toda la vida del proceso. Úsalo cuando un cliente deba ver un
conjunto más estrecho que el resto — un agente de pruebas limitado a una base de
staging, por ejemplo — o para que una configuración anterior a 1.21 siga
funcionando sin tocarla.

La fijación es absoluta en ambos sentidos: marcar una conexión en la app no
amplía un cliente fijado, y desmarcarla no lo estrecha. Un argumento que
escribió el usuario manda sobre una casilla, así que la única forma de cambiar
lo que ve un cliente fijado es editar su configuración y reiniciarlo — que es
justo la fricción que las casillas existen para quitar, así que prefiérelas
salvo que quieras expresamente un cliente con un conjunto distinto.

El id de un perfil está en Ajustes → MCP, o en `profiles.json` dentro del
directorio de configuración de tu plataforma (`%APPDATA%\HuginnDB` en Windows,
`~/.config/HuginnDB` en Linux, `~/Library/Application Support/HuginnDB` en
macOS) — es el campo `id`, no el `name` visible.

## Huella de conexiones

El conector es un proceso **separado** de la app de escritorio de HuginnDB, con
sus propios pools de conexiones. No comparte los de la app. Eso tiene una
consecuencia que conviene conocer antes de apuntarlo a una base de datos que
también usa otra gente:

- Cada cliente MCP que tenga `huginndb-mcp` configurado lanza **su propia
  copia**. Claude Code y Claude Desktop configurados contra el mismo perfil son
  dos procesos, cada uno con su pool.
- Esos pools se suman a los de la app de escritorio, a los del origen de datos de
  tu IDE y a los de cualquier backend que apunte al mismo servidor. Todos cuentan
  contra el mismo `max_connections` del servidor.

Dos valores por defecto lo mantienen acotado:

- **`--max-connections` vale `2`** por conexión expuesta, en lugar del `5` de la
  app de escritorio. MCP es petición/respuesta sobre stdio y las herramientas se
  despachan de una en una, así que un pool mayor no compra nada aquí. Es además
  un presupuesto *por servidor* dentro de este proceso: dos conexiones expuestas
  que apunten al mismo host lo comparten en lugar de tener una cada una.
- **Los pools inactivos se cierran a los 5 minutos** sin llamadas. El conector es
  de vida larga pero su trabajo va a ráfagas; un pool abierto para una pregunta no
  se mantiene el resto de la semana. Se reabre de forma transparente en la
  siguiente llamada.

### Compartir los pools de la app

Si la app de escritorio está en ejecución, puede atender las consultas del
conector con *sus propios* pools — activa **Ajustes → Conexiones → Compartir
pools con el conector MCP**. Entonces:

- Toda la máquina tiene un único presupuesto por servidor. La app es dueña de
  todas las conexiones; el conector (y cualquier otro conector, uno por cliente
  MCP) no abre ninguna.
- La actividad del conector aparece en la **Consola** de la app en directo — cada
  exploración, consulta y escritura, en el momento — en lugar de solo en
  `mcp-audit.log` a posteriori. Las escrituras se siguen auditando en ese fichero
  igualmente.
- El nivel de escritura lo vuelve a comprobar la app, de forma independiente a la
  comprobación del propio conector.

Está **desactivado por defecto**, porque abre un listener (solo loopback y
protegido por token) que da frente a todas las bases de datos que tengas
guardadas. Cuando la app no está en ejecución —o el ajuste está apagado— el
conector abre sus propios pools exactamente como se describe arriba, y lo indica
por stderr si pierde la app a mitad de sesión.

Si un servidor sigue justo, fija un techo por conexión en HuginnDB (Ajustes →
Conexiones, o el campo **Máximo de conexiones** de la propia conexión). Se guarda
en `profiles.json`, que este conector lee, así que se aplica al sidecar sin
configuración adicional. Ajustes → Conexiones muestra además cuántos pools
mantiene la app de escritorio ahora mismo, y permite liberar los de cada base de
datos a demanda.

## Herramientas

| Herramienta | Qué hace |
| --- | --- |
| `list_connections` | Qué bases de datos puede alcanzar este servidor. |
| `list_databases` | Bases de datos / esquemas / catálogos de una conexión. |
| `list_tables` | Tablas y vistas, con recuentos de filas y tamaños aproximados. |
| `describe_table` | Estructura completa: columnas, tipos, nulabilidad, PK, FKs, índices. Funciona también sobre una vista, y añade un objeto `view` con su definición cuando la relación lo es — `query` (el cuerpo del SELECT) en SQL, `viewOn` + `pipeline` en MongoDB. |
| `list_indexes` | Índices de una tabla y las columnas que cubre cada uno. En MongoDB cada entrada lleva además un objeto `mongo` con la definición completa — dirección y tipo de cada clave, `sparse`, TTL, filtro parcial, colación, pesos, tamaño y uso. Léelo antes de recrear un índice: la lista de columnas por sí sola no distingue `{createdAt: -1}` de `{createdAt: 1}`. |
| `run_query` | Ejecuta una única sentencia de **solo lectura** (SQL para Postgres/MySQL/SQLite/SQL Server, estilo mongosh para MongoDB). Cualquier cosa que escriba se rechaza aquí diga lo que diga el nivel. |
| `run_write` *(escritura)* | Ejecuta una única sentencia que **cambia** la base de datos. El DML necesita `data`, el DDL `full`. Una lectura también se rechaza aquí — va en `run_query`, que no necesita permiso de escritura. |
| `browse_table` | Navega una página de filas sin escribir SQL. |
| `server_version` | El motor y la versión conectados. |
| `list_users` / `list_privileges` | Usuarios/roles del servidor y sus permisos. |
| `pulse_health` | Constantes vitales en vivo — consultas/s, presión de conexiones, tasa de aciertos de caché — normalizadas a un único catálogo de métricas sea cual sea el motor. Solo MySQL y MongoDB. |
| `pulse_metrics` | Histórico guardado de una métrica, leído del muestreador en disco de Pulse, de más antiguo a más reciente. Vacío salvo que la conexión tenga el muestreador de histórico de Pulse activado en Ajustes. |
| `pulse_top_queries` | Sentencias en las que el servidor ha invertido más tiempo, cada una con un `sample` ejecutable cuando hay uno disponible. |
| `pulse_explain` | El plan que usaría el servidor para una sentencia — típicamente el propio `sample` de una fila de `pulse_top_queries` — sin llegar a ejecutarla. Rechaza cualquier cosa que no sea de solo lectura, una única sentencia, y que no sea ella misma `EXPLAIN`/`ANALYZE`. |
| `pulse_storage` | Las relaciones más grandes de la conexión, de mayor a menor, desglosadas en datos / índices / espacio libre. |
| `pulse_sessions` | Cada sesión u operación abierta ahora mismo en el servidor, con una cadena de bloqueo a mejor esfuerzo en MySQL. |
| `pulse_index_usage` | Uso de índices en las relaciones más grandes, de menos a más leído — la forma más rápida de detectar un índice que nadie lee. |
| `insert_row` *(escritura)* | Inserta una fila (valores como texto; valores por defecto de la BD para columnas omitidas). Requiere `data` o `full`. |
| `update_cell` *(escritura)* | Actualiza una columna de la única fila identificada por su clave primaria completa. Requiere `data` o `full`. |
| `delete_rows` *(escritura)* | Borra una o más filas, cada una identificada por su clave primaria completa. Requiere `data` o `full`. |
| `save_view` *(escritura)* | Crea una vista, redefine una existente o la renombra. Pasa solo `name` y `query` — la herramienta lee la definición actual para decidir cuál de las tres es. Con `preview: true` devuelve las sentencias sin ejecutarlas, y eso es una lectura. Requiere `full`. |
| `drop_view` *(escritura)* | Elimina una vista. Rechaza cualquier cosa que no lo sea. Requiere `full`. |
| `create_index` *(escritura)* | **Solo MongoDB.** Crea un índice. `keys` es texto fuente (`{createdAt: -1}`, `{location: "2dsphere"}`), más las opciones habituales — unique, sparse, hidden, TTL, filtro parcial, colación, pesos de texto y una vía de escape `extraOptions`. Requiere `full`. |
| `drop_index` *(escritura)* | **Solo MongoDB.** Elimina un índice por nombre. `_id_` se rechaza. Requiere `full`. |

`list_connections` informa del nivel de escritura efectivo de cada conexión,
para que el asistente sepa de antemano qué puede hacer.

Cada herramienta lleva además un **título** y **anotaciones** MCP:
`readOnlyHint` en las diecisiete que solo leen, y `destructiveHint` /
`idempotentHint` en las ocho que escriben (`insert_row` y `create_index` se
marcan como aditivas, no destructivas). Los clientes las usan para decidir
cuánta fricción merece una llamada, así que un `list_tables` ya no parece tan
arriesgado como un `delete_rows`.

Leer y escribir son **dos herramientas** — `run_query` y `run_write` — en vez
de una que abarque ambas. Las reglas de permisos de un cliente se aplican por
nombre de herramienta, así que un ejecutor único hacía imposible expresar "los
SELECT que pasen, lo demás que me pregunte", y obligaba a que la anotación
describiera el más peligroso de los dos tiers. Separadas, ambas son constantes
honestas que ningún cambio de nivel puede dejar obsoletas: `run_query` es
`readOnlyHint`, `run_write` es `destructiveHint`. Cada una rechaza el tráfico
de la otra y dice qué herramienta usar en su lugar.

### Índices: por qué las dos herramientas de escritura son solo de MongoDB

En los drivers SQL un índice se crea con `CREATE INDEX`, que `run_write` alcanza
en `full` y que es estrictamente más expresivo que cualquier forma portable —
`USING gin`, `INCLUDE`, un predicado parcial, un índice sobre expresión. Una
herramienta tendría que aplanar todo eso en un conjunto fijo de campos, y el
vocabulario de índices del lado SQL de HuginnDB es deliberadamente estrecho
(nombre, columnas, unique) porque existe para que el editor de estructura lo
*diffee*, no para describir cualquier índice que un servidor sepa construir.
Exponerlo como herramienta sería un retroceso.

MongoDB es el caso opuesto: hasta 1.19.0 la gramática mongosh no tenía
`createIndex` en absoluto, así que la operación no era alcanzable *por ninguna
vía*. Ahora existen las dos — las dos herramientas y
`db.coll.createIndex(...)` por `run_write` — y comparten una sola
implementación.

No hay herramienta para «editar» un índice porque MongoDB no puede alterarlo en
sitio: reemplazarlo es `drop_index` y luego `create_index`, y dejarlo en dos
llamadas mantiene visible para quien llama la ventana en la que el índice no
existe. Ocultar un índice (`collMod`) se alcanza por `run_write` como
`db.coll.hideIndex("nombre")` — la forma reversible de ensayar un borrado.

### Pulse: cómo `pulse_metrics` llega al histórico del muestreador

`pulse_metrics` lee `pulse.db` — el fichero SQLite en el que el propio
muestreador en segundo plano de HuginnDB escribe una lectura cada 60 segundos
por cada conexión con el muestreador de histórico de Pulse activado
(Ajustes → Pulse). Llegar hasta él no necesita ningún tratamiento especial
para ninguna de las dos formas en que corre este conector:

- **Con el puente de la app de escritorio activo**, esta herramienta (como
  cualquier otra) la sirve la app, así que lee directamente el propio
  manejador de `pulse.db` de la app.
- **En modo sidecar independiente**, el conector abre el *mismo* fichero en
  la misma ruta — `pulse.db` vive junto a `profiles.json` en el directorio de
  configuración de la plataforma, resuelto de forma idéntica por los dos
  procesos — y solo llega a ejecutar un `SELECT` contra él. Nunca ejecuta el
  muestreador él mismo (ese bucle solo arranca dentro de la secuencia de
  lanzamiento de la propia app de escritorio), así que no hay ninguna vía de
  escritura que proteger; el modo de journal WAL de este fichero, que usa
  siempre, ya permite cualquier número de lectores concurrentes junto al
  único escritor de la app.

En cualquiera de los dos casos, una respuesta vacía significa que el
muestreador de Pulse nunca se ha ejecutado para esa conexión — actívalo en
Ajustes, espera una lectura o dos, y pregunta de nuevo.

## MongoDB: apuntar a una base de datos en una conexión multi-base

Una conexión de MongoDB sin base de datos por defecto (`list_connections`
devuelve `database: ""` — la URI no tiene `/nombrebd`) no puede ejecutar
ninguna herramienta a nivel de tabla hasta que sepa qué base de datos usar,
ya que no hay nada equivalente a un catálogo SQL al que recurrir. Pasa el
nombre de la base de datos mediante:

- `schema` en `list_tables`, `describe_table`, `list_indexes`,
  `browse_table`, `save_view` y `drop_view`.
- `database` en `run_query` / `run_write` (su `sql` a secas no tiene campo para esto).

El servidor lo resuelve igual que el explorador de esquema de la app de
escritorio cuando expandes una base de datos — reutilizando el mismo cliente
de MongoDB y re-etiquetándolo, sin nueva conexión ni reautenticación — y lo
cachea, así que llamadas repetidas para la misma base de datos en la misma
conexión son baratas. Una conexión de una sola base de datos (con
`/nombrebd` ya en su URI) ignora esto — solo hace falta cuando
`list_connections` muestra un `database` vacío.

## Seguridad

- **Escrituras controladas por conexión.** Cada conexión expuesta tiene un
  nivel de escritura, configurado en **Ajustes → MCP** y guardado en
  `profiles.json`:
  - **`read-only`** (por defecto) — solo lecturas. `run_query` acepta
    `SELECT` / `WITH` / `SHOW` / `EXPLAIN` / `PRAGMA` (SQL) o
    `find`/`aggregate`/`countDocuments`/`distinct` (MongoDB), clasificado con
    el mismo clasificador de operaciones que usa el editor de consultas de
    escritorio — no una simple coincidencia de palabras clave SQL, así que las
    lecturas de mongosh no se confunden con escrituras. Toda herramienta de
    escritura se rechaza.
  - **`data`** — añade DML a nivel de fila: `INSERT`/`UPDATE`/`DELETE` vía
    `run_write`, más las herramientas `insert_row` / `update_cell` /
    `delete_rows`. Sin cambios de esquema.
  - **`full`** — añade DDL (`CREATE`/`DROP`/`ALTER`/`TRUNCATE`/…) vía
    `run_write`, más las herramientas `save_view` / `drop_view` /
    `create_index` / `drop_index`. En MongoDB este es también el nivel de
    `createIndex`/`dropIndex`/`hideIndex`, `drop()` y `renameCollection` vía
    `run_write`.

  Un índice y un *namespace* también son esquema, por la misma razón y con la
  misma consecuencia: `create_index` y `drop_index` viven en `full`, igual que
  cualquier sentencia de MongoDB que toque un índice o la existencia de una
  colección.

  Una vista es esquema, y eso deja su gestión en `full` y no en `data`. Suena
  raro por un segundo — eliminar una *vista* pide `full` mientras que borrar
  *filas* solo pide `data` — y es la misma asimetría que ya existe entre
  `DROP TABLE` y `DELETE FROM`. Es además la única respuesta coherente: el
  `CREATE OR REPLACE VIEW` que podrías escribir a mano por `run_write` está
  clasificado como DDL, así que una conexión en `data` lo tiene rechazado, y
  una herramienta que permitiera el mismo cambio devolvería justo lo que el
  nivel acaba de negar. El `preview: true` de `save_view` es una excepción de
  verdad, no un agujero: construye las sentencias y no ejecuta nada, así que
  está clasificado como lectura y funciona en cualquier nivel.

  El nivel se relee de disco en **cada intento de escritura**, así que
  cambiarlo en la app surte efecto sin reiniciar el cliente de IA.
- **La aprobación la da el cliente.** El conector es un proceso headless que
  lanza tu cliente MCP; no puede mostrar un prompt. La aprobación por acción
  («¿permitir esta herramienta?») la pide el cliente (Claude Code / Desktop /
  Cursor la piden). El papel del conector es la *política* (qué se permite) y
  la *auditoría*. Son dos puertas independientes, y un nivel `full` es un
  *techo*, no una instrucción para el cliente — ver [Cuando el bloqueo viene
  del cliente, no del
  conector](#cuando-el-bloqueo-viene-del-cliente-no-del-conector).
- **Log de auditoría.** Cada escritura (éxito o fallo) añade una línea a
  `mcp-audit.log`, en el mismo directorio de configuración que `profiles.json`.
  Las lecturas no se registran, así que el fichero es un registro limpio de las
  operaciones que cambian estado.
- **Guarda anti-relación-entera.** Un `UPDATE`/`DELETE` sin `WHERE` en
  `run_write` se rechaza de plano, en cualquier nivel — añade un predicado
  explícito (`WHERE 1=1` si de verdad quieres todas las filas). MongoDB entra
  en la misma guarda: `updateMany({})` y `deleteMany({})` se rechazan, y la
  forma de decir que lo quieres es un predicado trivialmente cierto, p. ej.
  `deleteMany({_id: {$exists: true}})`. `drop()` queda fuera: su alcance no es
  ambiguo y ya está detrás de `full`, exactamente como `DROP TABLE`.
- **Kill-switch global.** `--read-only` fuerza todas las conexiones a solo
  lectura sin importar su nivel guardado.
- **Exposición opt-in.** Solo son alcanzables las conexiones marcadas en
  Ajustes → MCP (o nombradas por `--connections`); cualquier otra llamada se
  rechaza, y el *nombre* de una conexión solo puede resolver a una que ya esté
  expuesta. La exposición se relee en cada llamada, así que desmarcar una le
  quita el acceso a un cliente en marcha de inmediato. Además es estrictamente
  local: una sincronización de origen compartido nunca la cambia y se limpia al
  importar perfiles, así que ni un publicador ni un fichero que hayas importado
  pueden exponer una base de datos en tu máquina.
- **Sin texto plano nuevo.** Las contraseñas se leen del llavero del sistema
  en el momento de conectar, igual que la app de escritorio. El conector
  nunca las registra ni las persiste (el log de auditoría registra sentencias
  y recuentos de filas, nunca credenciales).
- **Límite de filas.** `--max-rows` acota cada conjunto de resultados.

### Cuando el bloqueo viene del cliente, no del conector

Una escritura la puede rechazar *cualquiera* de las dos puertas, y cada una
responde a un dueño distinto. El síntoma que despista: una conexión en `full`
en Ajustes → MCP y el asistente diciendo aun así que no puede ejecutar un
`CREATE`/`ALTER`/`DROP`.

Distinguirlas lleva un segundo:

| | Rechazo del conector | Bloqueo del cliente |
| --- | --- | --- |
| Qué ves | Un *resultado* de la herramienta nombrando el nivel: *«connection … has MCP write policy "read-only", which does not permit this operation (needs at least "full")»* | La denegación del propio cliente. En el modo auto de Claude Code el motivo suele ser el texto fijo `Blocked by classifier` |
| `mcp-audit.log` | Se añadió una línea (los rechazos también se registran) | **Nada** — la llamada nunca llegó al conector |
| Quién lo cambia | Tú, en HuginnDB → Ajustes → MCP | Quien ejecuta el cliente de IA, en *su* configuración |

En concreto con Claude Code: en [modo auto](https://code.claude.com/docs/en/permission-modes#eliminate-prompts-with-auto-mode)
un segundo modelo — el clasificador — revisa cada acción en lugar de
preguntarle al usuario, y las llamadas a herramientas MCP pasan por ahí. Su
lista de bloqueos por defecto incluye *«production deploys and migrations»* y
*«modifying shared infrastructure»*, y hasta que nombres objetivos concretos
trata cualquier host o namespace cuyo nombre lleve `prod` como objetivo remoto
sensible. Un DDL contra un servidor de base de datos real encaja justo ahí,
diga lo que diga la política de HuginnDB — y el clasificador no tiene forma de
saber que el servidor es una instancia de pruebas desechable si nadie se lo
dice.

Los arreglos viven todos en el lado del cliente, y todos son decisión de la
persona que lo ejecuta — el conector no puede ni debe intentar influir en ellos:

- **Puntual:** abrir `/permissions` → **Recently denied** y pulsar `r` sobre la
  entrada para reintentarla con aprobación manual.
- **Ser específico en la petición.** La intención explícita del usuario levanta
  los bloqueos blandos del clasificador; una genérica no. *«ordena el esquema»*
  no autoriza un DDL, *«ejecuta este `ALTER TABLE` en la base `sandbox`»* sí.
- **Pre-aprobar la herramienta** con una [regla
  allow](https://code.claude.com/docs/en/permissions#permission-rule-syntax) en
  `~/.claude/settings.json`, que se resuelve *antes* de que corra el
  clasificador. El segmento del servidor tiene que ser literal — un glob sin
  anclar se ignora:

  ```json
  {
    "permissions": {
      "allow": ["mcp__huginndb__run_query"]
    }
  }
  ```

- **Dar contexto al clasificador** sobre la base de datos con entradas
  [`autoMode`](https://code.claude.com/docs/en/auto-mode-config) (solo en
  settings de usuario o gestionados — el clasificador ignora a propósito el
  `.claude/settings.json` del repo). Mantén `"$defaults"` o reemplazas las
  reglas integradas por completo:

  ```json
  {
    "autoMode": {
      "environment": ["$defaults", "Key internal services: the `sandbox` SQL Server instance at db-test.example.internal is a disposable test database, restored nightly from a fixture"],
      "allow": ["$defaults", "Schema changes on the `sandbox` database through the huginndb MCP connector are allowed: it holds no production data"]
    }
  }
  ```

- **O salir del modo auto** (Shift+Tab → Manual) y aprobar cada llamada a mano.

Nada de esto afloja el conector: su política se relee de disco en cada intento
de escritura y se aplica *después* de que el cliente haya aprobado la llamada,
así que una conexión dejada en `read-only` sigue siendo de solo lectura por
permisiva que sea la configuración del cliente. Esa asimetría es justamente el
punto — el cliente controla *a este asistente en esta máquina*, el nivel de
escritura controla *la base de datos*.

## Drivers soportados

PostgreSQL, MySQL, SQLite, MongoDB y Microsoft SQL Server — los mismos
drivers que la app de escritorio, mediante el mismo código de backend.

Las herramientas de lectura funcionan igual en todos, y también las de
escritura a nivel de fila (`insert_row`, `update_cell`, `delete_rows`).

El único hueco es `save_view` en SQL Server, cuyo generador de DDL T-SQL para
vistas todavía no existe: ahí devuelve un error de «driver no soportado». Todo
lo demás sobre vistas funciona en los cinco: `describe_table` informa de la
definición de una vista en todos los drivers, y `drop_view` funciona en todos.

`create_index` y `drop_index` son solo de MongoDB y devuelven un error de
«driver no soportado» en el resto; `list_indexes` lee en los cinco. Ver
[Índices: por qué las dos herramientas de escritura son solo de
MongoDB](#índices-por-qué-las-dos-herramientas-de-escritura-son-solo-de-mongodb).

No hay herramienta para editar la estructura de una *tabla* en ningún driver.
Se dejó fuera a propósito (ver
[`MCP_CONNECTOR_ROADMAP.md`](MCP_CONNECTOR_ROADMAP.md)): hacer que un asistente
sintetice una lista de columnas completa, con tipos, nulabilidad, valores por
defecto y claves, es peor que hacerle emitir `ALTER TABLE` por `run_write`, que
`full` permite. Ese argumento va del *tamaño del DTO*, y por eso no se traslada
a los índices de MongoDB: la especificación de un índice es un documento de
claves y un puñado de flags, más cerca de `save_view` que de una tabla.
