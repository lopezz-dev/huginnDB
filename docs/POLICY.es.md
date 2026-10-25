# Política gestionada

Cuando una organización gestiona HuginnDB, un administrador escribe **una sola
política** que leen todas las instalaciones. Dice, por rol, a qué puede acceder
la IA en cada base de datos y qué puede hacer: qué bases de datos y relaciones
ve, y si puede leer, insertar, actualizar, borrar o cambiar el esquema, cada
cosa por separado.

Esta guía es para el administrador que la despliega. Si eres usuario y quieres
saber qué se te aplica, abre **Ajustes → Política**.

## Qué aplica esta versión y qué no

**Para la IA, la política se aplica de verdad, no es orientativa.** El modelo
nunca tiene la contraseña de la base de datos: la tiene HuginnDB, y todas las
peticiones de una IA —por el conector MCP (`huginndb-mcp`) o por el panel de IA
de la app— pasan por un único punto donde se comprueba la política. Si la
política la rechaza, la IA no puede hacerlo. Da igual que la app esté abierta o
que el conector funcione solo.

**Para las personas, la política la aplica la app, como guardarraíl.** Todos
los comandos que la app lanza contra una base de datos comprueban antes los
permisos `human` de la persona: el explorador solo muestra lo que su rol puede
ver, una escritura que no tiene permitida se rechaza, y las consultas libres
—el editor de consultas, la expresión escrita a mano del panel de consulta, el
cuerpo de una vista, un pipeline de MongoDB que une otras colecciones— se
rechazan en una regla que limita relaciones. Es un guardarraíl y no un muro, y
conviene decir claramente por qué: una persona que tiene la contraseña de la
base de datos puede abrir otro cliente y saltarse HuginnDB por completo. La
forma de que las restricciones de las personas no se puedan saltar es que cada
persona se conecte con **su propio usuario de base de datos**, con permisos que
coincidan con la política; generar esos permisos a partir de la política es la
siguiente fase.

Lo que ve una persona: una tabla o base de datos a la que su rol no llega no
aparece en ningún listado, y una acción que no permite sigue en su sitio,
deshabilitada, con un candado y el motivo: en un menú, bajo el nombre del
elemento; en un botón, al pasar el ratón. Una pestaña cuyo propósito entero no
está permitido (el editor de consultas sin consultas libres, Seguridad o Pulse
sin `monitor`) muestra una página bloqueada en su lugar. Mientras la política
carga o no se puede aplicar, una barra en la ventana lo dice y enlaza a
Ajustes → Política.

Cuando un rol solo puede escribir algunas columnas, la cabecera de la tabla
muestra un candado en las demás y una línea sobre las filas nombra las que se
pueden modificar. Una celda bloqueada se sigue abriendo, en solo lectura, para
leer su valor entero; una fila nueva deja las columnas bloqueadas con su valor
por defecto.

La política solo **restringe**, nunca amplía. Los ajustes por conexión que ya
tienen los usuarios —qué conexiones se exponen al MCP, su nivel de escritura
MCP, si el panel de IA está activado— siguen aplicándose. Lo que puede hacer la
IA es la política *y además* esos ajustes.

## Dónde se pone la política

HuginnDB busca en dos sitios, en este orden, y usa el primero que tenga una
política:

1. **Registro** (Windows): `HKLM\SOFTWARE\Policies\HuginnDB`
   - `Policy` (REG_SZ): el JSON de la política, o
   - `PolicySource` (REG_SZ): la ruta al fichero de la política, normalmente en
     una carpeta compartida: `\\servidor\it\huginndb-policy.json`.

   Es lo que escriben las directivas de grupo e Intune.
2. **Fichero**: `managed-policy.json` en la carpeta de políticas del sistema:
   - Windows: `C:\Program Files\HuginnDB\`
   - Linux: `/etc/huginndb/`
   - macOS: `/Library/Application Support/HuginnDB/`

   Puede contener la política o solo un puntero a la compartida:

   ```json
   { "source": "\\\\servidor\\it\\huginndb-policy.json" }
   ```

Para escribir en cualquiera de los dos sitios hacen falta permisos de
administrador, y esa es la idea: un usuario normal no puede quitarlos ni
sustituirlos. `HKCU` **no** se lee, porque el usuario puede escribir en él.
Tampoco se lee nada de variables de entorno.

**Protege el fichero compartido.** Si la política está en una carpeta
compartida, solo los administradores deben poder escribir en ella; si no, las
personas a las que restringe pueden editarla. HuginnDB no firma el fichero: la
protección son los permisos de la carpeta.

HuginnDB lee la política al arrancar y otra vez **cada 5 minutos**, así que un
cambio llega a las instalaciones abiertas sin reiniciarlas.

## Si la política no se puede leer

**Se bloquea.** Si existe un ancla pero el fichero al que apunta no se puede
leer (la carpeta compartida no responde, el fichero se ha movido) o no es
válido, se rechazan todas las peticiones de la IA, y una persona puede abrir la
app y sus ajustes pero ninguna conexión deja leer ni escribir; cada rechazo
nombra el fichero y el error, y Ajustes → Política lo muestra en rojo. HuginnDB
nunca vuelve a "sin política", ni guarda una copia local a la que volver.

Mientras se lee por primera vez una política de una carpeta compartida, las dos
quedan en pausa igual, normalmente bastante menos de un segundo.

## El formato

```json
{
  "version": 1,
  "defaultRole": "none",
  "users": {
    "ana": "ventas",
    "pau": "produccion",
    "CORP\\scara": "admin"
  },
  "roles": {
    "none": {},
    "ventas": {
      "rules": [{
        "endpoint": { "driver": "mysql", "host": "erp.corp.local", "port": 3306 },
        "databases": ["facturacion"],
        "relations": { "allow": ["facturas", "v_factura_*"], "deny": ["v_factura_tarjetas"] },
        "human": ["select", "insert", "update"],
        "ai": ["select"]
      }]
    },
    "produccion": {
      "rules": [{
        "endpoint": { "host": "erp.corp.local" },
        "databases": ["prod_*"],
        "human": ["select", "insert", "update", "delete"],
        "ai": ["select", "insert"]
      }]
    },
    "admin": {
      "rules": [{
        "endpoint": "*",
        "human": ["select", "insert", "update", "delete", "ddl", "export", "monitor"],
        "ai": ["select", "monitor"]
      }]
    }
  },
  "unmanagedConnections": "deny"
}
```

Cualquier campo que HuginnDB no reconozca —una errata como `"relatons"`— hace
que toda la política sea inválida, y se bloquea. Una restricción mal escrita
nunca se interpreta como "sin restricción".

### Usuarios y roles

- Un usuario es la **cuenta del sistema operativo** con la que se ejecuta
  HuginnDB, leída del propio sistema. Los nombres se comparan sin distinguir
  mayúsculas, con o sin el prefijo `DOMINIO\`. HuginnDB muestra la cuenta sin
  el dominio (`alopez` para `ITBACKING\alopez`), y en la política vale
  cualquiera de las dos formas.
- **La política da por hecho un único dominio.** Como el dominio se descarta
  antes de comparar, `ITBACKING\alopez` y `CLIENTE\alopez` son el mismo usuario
  para la política y reciben el mismo rol. En una organización con un solo
  dominio no importa. Si la tuya tiene varios dominios de confianza con nombres
  de cuenta que se repiten, no despliegues la política hasta que HuginnDB
  compare también el dominio: todavía no lo hace. Una cuenta local de Windows
  con el mismo nombre que una del dominio no sirve para saltársela, porque
  crearla exige ser administrador del equipo, y un administrador ya puede
  quitar la política.
- Cada usuario tiene **exactamente un rol**. Poner la misma cuenta dos veces
  (por ejemplo `ana` y `CORP\ana`) es un error.
- Quien no aparezca en la lista recibe `defaultRole`. Haz que sea el rol más
  restrictivo; aquí, `none`, que no da acceso a nada.

### Reglas

Un rol es una lista de reglas. Cada regla dice a qué servidor se refiere y qué
permite en él.

- **`endpoint`**: `"*"` para todos los servidores, o un objeto:
  - `host` (obligatorio), con `driver` (`postgres`, `mysql`, `sqlserver`,
    `mongodb`) y `port` opcionales. Los hosts se comparan sin distinguir
    mayúsculas ni espacios alrededor, y sin consultar DNS. Un puerto en blanco
    en la conexión de un usuario cuenta como el puerto por defecto del driver.
  - `path` para un fichero SQLite (cualquier barra, sin distinguir mayúsculas).

  Las reglas se aplican al **servidor**, no a la conexión guardada: un usuario
  que vuelva a crear una conexión a mano sigue cubierto.
- **`databases`**: nombres de bases de datos, con `*` como comodín. Si se
  omite, cubre todas las bases de datos del servidor.
- **`relations`**: tablas y vistas, con `allow` (si se omite, todas) y `deny`
  (siempre gana). Un patrón con punto se compara con `schema.nombre`
  (`public.*`); uno sin punto, solo con el nombre. En MySQL y MongoDB el schema
  de una relación *es* su base de datos, así que `facturacion.facturas` también
  funciona ahí. La comparación no distingue mayúsculas.
- **`human`** y **`ai`**: lo que pueden hacer la persona y la IA:
  | Permiso | Permite |
  |---|---|
  | `select` | leer filas y describir relaciones |
  | `insert`, `update`, `delete` | cada escritura de filas, por separado |
  | `ddl` | cambios de esquema: crear, alterar, borrar, truncar, índices, vistas |
  | `monitor` | Pulse, sesiones del servidor, usuarios y privilegios: muestran sentencias *de otras personas*, que pueden contener datos que este rol no puede leer |
  | `export` | sacar las filas de una tabla a un fichero; necesita también `select` sobre ella |

  La IA nunca tiene más que la persona: lo que `ai` añada respecto a `human` se
  ignora, y Ajustes → Política muestra un aviso.
- **`columns`**: a qué columnas puede dar valor `insert` y cuáles puede
  modificar `update`, en todas las relaciones que alcanza la regla:
  `"columns": { "insert": ["cliente", "importe", "estado"], "update": ["estado",
  "observaciones"] }`. Un verbo que no aparece en `columns` alcanza todas las
  columnas; una lista vacía, ninguna. Los patrones funcionan como en las
  relaciones (`obs_*`, sin distinguir mayúsculas). La lectura no se limita:
  quien puede leer la tabla sigue viendo todas sus columnas. En MongoDB una
  columna es un campo y se juzga por su nombre de primer nivel —cambiar
  `direccion.cp` cambia `direccion`—, y el `_id` de un documento siempre se
  puede dar al insertar. Para que una tabla tenga columnas distintas del resto,
  escribe una regla aparte para ella.

  Dos reglas sobre la misma tabla se suman: una columna que permita cualquiera
  de ellas está permitida, y una regla que no limita un verbo lo permite en
  todas las columnas. El límite vale igual para la persona que para su IA.
- **`dbUser`**: el usuario de base de datos con el que una persona entra en este
  servidor; ver
  [Cada persona con su propio usuario de base de datos](#cada-persona-con-su-propio-usuario-de-base-de-datos).

Una sentencia que hace dos cosas necesita los dos permisos: un upsert necesita
`insert` y `update`, y el `REPLACE` de MySQL necesita `insert` y `delete`.

### Consultas libres en una regla limitada

Si una regla limita **qué bases de datos o relaciones** se ven (`databases`,
`relations.allow` o `relations.deny`), la IA **no puede lanzar consultas
libres** en esa conexión, solo usar las herramientas de tabla (listar,
describir, examinar y las escrituras de filas que permita la regla). Ninguna
herramienta puede saber con fiabilidad, a partir del texto de una consulta,
todas las tablas que toca: las vistas, las funciones, el SQL dinámico y los
catálogos del sistema como `INFORMATION_SCHEMA` o `master` serían formas de
saltarse la restricción. Una regla sobre un servidor entero mantiene las
consultas libres, con los límites de sus permisos.

**Los límites por columna cierran las escrituras libres, no las lecturas.** Con
una regla que limita `columns.update`, un `UPDATE` libre se rechaza por el mismo
motivo —el texto de una sentencia no dice con fiabilidad qué columnas escribe
(triggers, vistas, SQL dinámico)—, e igual un `INSERT` con `columns.insert`. Las
lecturas libres siguen disponibles salvo que la regla limite también bases de
datos o relaciones; entonces se aplica el párrafo anterior.

El descubrimiento también se filtra: la lista de bases de datos y tablas que ve
la IA solo contiene lo que el rol alcanza, así que no llega a saber los nombres
del resto.

**El terminal de `mongosh`** (consulta `MONGODB.es.md`) es texto libre con
todos los verbos: una vez abierto, se puede leer cualquier colección y escribir
o borrar cualquier cosa, y nada de lo que se teclee en él puede comprobarse
contra la política. Por eso a una persona solo se le ofrece en una conexión
donde su rol permite consultas libres con `select`, `insert`, `update`,
`delete` y `ddl` — y HuginnDB se niega a abrirlo en otro caso, muestre lo que
muestre la interfaz. Un shell normal en el mismo panel no lleva ninguna
credencial y no se ve afectado.

### Conexiones que la política no nombra

`unmanagedConnections` decide qué pasa con una conexión que no casa con ninguna
regla del rol del usuario:

- `"deny"` (por defecto): la IA no puede usarla. Esto también hace inútil
  llegar a un servidor con otro nombre (una IP en lugar de su nombre de host)
  para saltarse una regla.
- `"allow"`: la política no la toca y solo se aplican los ajustes locales del
  usuario.

### Descargar herramientas

`"allowToolDownloads": true` en un **rol** permite a quienes lo tienen que
HuginnDB les descargue una herramienta — hoy, el `mongosh` que el Terminal puede
bajar de la web de descargas de MongoDB (véase `MONGODB.es.md`). **Está
desactivado salvo que el rol lo diga**: un equipo gestionado no baja ni ejecuta
un programa de internet solo porque nadie pensó en prohibirlo. Sin el permiso, el
Terminal no muestra el botón **Descargar mongosh** y explica por qué, HuginnDB
rechaza la petición aunque la interfaz la mostrara, y un `mongosh` que la persona
haya instalado (o que tú despliegues) se usa igual que antes. Una política que
aún se está leyendo, o que no se puede aplicar, también bloquea las descargas.
Sin política, la descarga está permitida.

```json
"roles": { "analista": { "allowToolDownloads": true, "rules": [ … ] } }
```

## Cada persona con su propio usuario de base de datos

Para las personas, la política de la app es un guardarraíl, porque la propia
contraseña de la base de datos abre cualquier cliente. Lo que lo cierra es dar a
**cada persona su propio usuario de base de datos**, con los permisos de su
rol: así es la base de datos la que aplica la política, y la contraseña
compartida no tiene por qué llegar al equipo de nadie.

- **`dbUser`** en una regla fija el usuario con el que una persona entra en ese
  servidor. Es una plantilla con un único token, `{user}`, que es su cuenta de
  Windows sin el dominio y en minúsculas: `"dbUser": "{user}"` conecta a
  `ACME\ALopez` como `alopez`; `"erp_{user}"`, como `erp_alopez`. Vale para
  todo el servidor que nombra la regla (sus `databases` no lo acotan), y gana la
  primera regla del rol para ese servidor que lo tenga. La persona no puede
  cambiarlo: el diálogo de la conexión lo muestra con un candado.
- Sin `dbUser`, una persona puede elegir igualmente su propio usuario en una
  conexión que viene de un origen compartido (**Tus credenciales**, en el
  diálogo). Se queda en su equipo: nunca se publica, se exporta ni se
  sincroniza.
- La primera vez que una persona se conecta con su propio usuario, HuginnDB le
  pide la contraseña y, si lo marca, la recuerda en su llavero para ese usuario.
- Mientras una persona entra con su propio usuario, la contraseña del origen
  compartido para esa conexión **no** se guarda en su equipo. Para que no llegue
  a ningún equipo, publica la conexión sin contraseña.

> **Actualiza HuginnDB en todos los equipos antes de añadir `dbUser` o
> `columns`.** Las versiones anteriores a un campo no lo conocen, dan la
> política por no válida y bloquean todas las conexiones hasta que se
> actualicen.

### Generar los permisos

Un usuario de base de datos por persona solo aplica la política si sus permisos
coinciden con el rol. **Ajustes → Política → Generar permisos** los escribe:
elige un rol y un servidor al que estés conectado con una cuenta de
administrador, y HuginnDB construye el script a partir del catálogo del
servidor:

- PostgreSQL, MySQL y SQL Server: un rol de base de datos `huginn_<rol>` con sus
  `GRANT`; MongoDB: un `createRole` con las acciones sobre cada colección.
- Una regla sobre todas las relaciones de una base de datos concede a nivel de
  base de datos o de esquema, lo que cubre también las tablas que se creen
  después. Una regla que nombra relaciones (o tiene un `deny`) se expande a las
  tablas que existen ahora —un `GRANT` no admite comodines—, así que vuelve a
  generar el script después de crear tablas.
- Una regla con `columns` concede por columna, `GRANT UPDATE (estado,
  observaciones) ON pedidos`, sobre las columnas que cada tabla tiene ahora:
  vuelve a generar el script también después de añadir columnas. **SQL Server
  no puede limitar `INSERT` por columna** (sus permisos por columna son
  `SELECT`, `UPDATE` y `REFERENCES`): el script concede `INSERT` sobre toda la
  tabla y lo avisa, y `columns.insert` solo se cumple dentro de HuginnDB. Para
  que SQL Server lo haga cumplir, concede `INSERT` sobre una vista con solo esas
  columnas. MongoDB no tiene privilegios por campo, así que allí los dos límites
  solo se cumplen dentro de HuginnDB. PostgreSQL y MySQL hacen cumplir los dos.
- Las personas a las que la política da el rol aparecen al final, comentadas,
  tal como entran (`dbUser`, o su cuenta): revisa los nombres y descomenta.
- Las notas del script dicen lo que el motor no puede ocultar: PostgreSQL
  enseña el nombre de todas las relaciones en `pg_catalog`; SQL Server lista
  todas las bases de datos salvo que se revoque `VIEW ANY DATABASE` a `public`
  (se ofrece, comentado); `export` no tiene equivalente en la base de datos.

**HuginnDB nunca ejecuta el script.** Cópialo o guárdalo, revísalo y ejecútalo
tú como administrador.

## Editar la política desde HuginnDB

No hace falta escribir el JSON a mano. **Ajustes → Política → Editar
política** la abre como un formulario —roles y sus reglas, cuentas, rol por
defecto— con el JSON a un clic; los dos editan el mismo borrador.

- **Quién puede guardar lo decide la carpeta compartida, no HuginnDB.** El
  editor se abre en cualquier equipo, y solo guarda donde Windows deja a esa
  cuenta escribir en la carpeta de la política; en el resto es de solo lectura
  y muestra el motivo que da Windows. Es el mismo permiso que ya protege el
  fichero.
- **Un borrador que no es una política válida no se puede guardar.** Cada
  cambio lo comprueba el mismo analizador que aplica la política, y el error
  nombra el rol y la regla. Una errata ya no puede bloquear todos los equipos.
- **Ver como** enseña lo que tendría cualquier cuenta —y su IA— en cada conexión
  guardada con el borrador, antes de guardar nada, con las columnas que puede
  escribir cada verbo limitado.
- Bajo `insert` y `update`, **Todas / Solo estas** limita el verbo a las
  columnas elegidas de las propias tablas de la regla. Cada una indica si es
  obligatoria (sin valor por defecto ni NULL), si la pone el servidor o si
  falta en alguna de las tablas. El editor avisa, con un botón que lo corrige,
  cuando una columna obligatoria se queda fuera de `insert` —no se podría
  añadir ninguna fila— y cuando `delete` convive con un `update` limitado, ya
  que borrar una fila y volver a añadirla escribe cualquier columna.
- El servidor de una regla se elige entre las conexiones guardadas en este
  equipo, y sus bases de datos y tablas de la lista del propio servidor (la
  regla ofrece conectarse a él). También se puede añadir un patrón como
  `v_factura_*`: el campo enseña antes con qué nombres reales coincide, y marca
  un nombre que el servidor no tiene. Un servidor sin conexión guardada se puede
  seguir indicando a mano.
- Al guardar se conserva la versión anterior como `<fichero>.bak`, no se
  sobrescribe un cambio que otra persona haya guardado mientras tanto (tu
  versión va al portapapeles), y se aplica en este equipo al instante; en el
  resto, como mucho en cinco minutos.
- **¿Todavía no hay política?** *Crear política* parte de una plantilla en la
  que quien no esté en la lista no tiene nada y tú conservas acceso completo, la
  escribe donde elijas y te da el comando `reg add` y el valor de directiva de
  grupo que apuntan los equipos a ella. Una política incrustada en el registro
  o en Program Files se pasa a un fichero de la misma forma, para editarla aquí
  a partir de entonces.

## Cómo comprobarla

- **Ajustes → Política**, en cualquier equipo, muestra de dónde se ha leído la
  política, qué cuenta y qué rol ve HuginnDB, y qué permite cada conexión a la
  IA y a las personas.
- El registro de auditoría del conector MCP (`mcp-audit.log`, en la carpeta de
  configuración del usuario) anota `user=` y `role=` en cada escritura de la
  IA.

## Límites, dichos claramente

- Un **administrador local** puede editar el registro y la carpeta del sistema,
  así que esto protege frente a usuarios normales, no frente al dueño del
  equipo. Volver a desplegar la política con las directivas de grupo o con tu
  herramienta de gestión de equipos la mantiene en su sitio.
- La política la leen las versiones de HuginnDB que la soportan. Mantén la
  versión instalada bajo el control de IT, como cualquier software gestionado.
- Los nombres de servidor se comparan tal como están escritos. Una regla para
  `erp.corp.local` no cubre el mismo servidor si se llega a él como
  `10.0.0.5`; con `"deny"` para las conexiones sin gestionar, ese alias
  simplemente se rechaza.
