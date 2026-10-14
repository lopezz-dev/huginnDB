# Conexiones

> Nota: este archivo es la traducción al español de `CONNECTIONS.md`. Si ves algo
> desactualizado respecto al original en inglés, ese es el que manda.

Una **conexión** es un perfil guardado: qué driver, qué host, qué base de datos,
qué usuario. Hay una única lista global, compartida por todos los entornos (mira
[`ENVIRONMENTS.es.md`](ENVIRONMENTS.es.md) para ver cómo un entorno elige un
subconjunto de ella).

El perfil en sí son metadatos y vive en `profiles.json`, dentro del directorio de
configuración de tu plataforma. **La contraseña nunca.** Va al llavero del
sistema operativo — el Administrador de credenciales en Windows, o libsecret /
GNOME Keyring en Linux — y se lee al conectar. Nada de lo que HuginnDB escribe en
disco contiene una contraseña en texto plano.

## Crear una

**Archivo → Nueva conexión…**, o `Nueva conexión` desde la paleta de comandos
(`Ctrl+Shift+P`). El diálogo se adapta al driver, porque los cinco no necesitan
lo mismo:

| Driver | Qué necesita |
| --- | --- |
| PostgreSQL | Host, puerto, usuario, contraseña. La base de datos es opcional — ver más abajo. |
| MySQL / MariaDB | Lo mismo. |
| SQLite | Solo la **ruta del fichero de base de datos**. Sin host, sin usuario y sin contraseña: el fichero *es* la base de datos, y los permisos del sistema de ficheros son su control de acceso. |
| MongoDB | El formulario construye la URI `mongodb://` en vivo a partir de host/puerto/base/usuario + **Origen de autenticación** + **Conexión directa** (`directConnection=true`, para llegar a un miembro concreto de un replica set a propósito — ver [`MONGODB.es.md`](MONGODB.es.md)). **Editar cadena de conexión** desbloquea la URI para lo que el formulario no cubre: Atlas (`mongodb+srv://`), replica sets, opciones extra de la URI. |
| SQL Server | Host y puerto, más **Nombre de instancia**, **Confiar en el certificado del servidor** y **Autenticación** (inicio de sesión de SQL Server, o Windows/NTLM solo en Windows). Ver [`SQL_SERVER.es.md`](SQL_SERVER.es.md). |

**Nombre** y **Grupo** son solo presentación. El grupo es texto libre: escribe la
misma etiqueta en varias conexiones (un cliente, una sede, un entorno) y la lista
las agrupa. No hay un registro de grupos que mantener, y renombrar uno es
reescribir la etiqueta.

Al editar una conexión existente, dejar **Contraseña** en blanco mantiene la
guardada. Cambiarla significa escribir una nueva, no vaciar el campo.

## Deja la base de datos en blanco para tener el servidor entero

En PostgreSQL, MySQL y SQL Server, un campo **Base de datos** vacío es una
decisión deliberada con su propio comportamiento: el explorador te muestra las
bases de datos del servidor y tú abres las que quieras. Cada base que abres tiene
su propio pool hijo, que se cierra cuando lleva un rato sin usarse.

Dos consecuencias que conviene conocer:

- En PostgreSQL, conectar exige *alguna* base de datos, así que HuginnDB conecta
  a la base de mantenimiento `postgres`, que siempre existe, y lista el resto
  desde ahí.
- En MySQL, una sesión sin base de datos por defecto no tiene `DATABASE()`, así
  que el nodo de primer nivel no lista ninguna tabla. Eso es lo esperado, no un
  fallo: las tablas están bajo el nodo de cada base de datos.

Cuando una conexión alcanza más bases de las que te interesan, acótala con el
selector **Bases de datos a mostrar** del menú contextual de la conexión. Ese
filtro también se puede fijar por entorno, así que un servidor de pruebas
compartido puede mostrar la base de un cliente en un entorno y la de otro en
otro sin duplicar la conexión.

## SSL / TLS

La casilla **SSL** es explícita en los dos sentidos. Desmarcada significa *sin
TLS* (`sslmode=disable` en Postgres, TLS apagado en MySQL), no «inténtalo y si no
tira sin él»: el intento de negociación contra un servidor o un pooler que no lo
habla falla de plano con un error poco útil, así que una casilla desmarcada tiene
que significar texto plano.

SQL Server cifra por defecto y la mayoría de instalaciones on-premise presentan
un certificado autofirmado; por eso tiene su propio interruptor **Confiar en el
certificado del servidor** en lugar de la casilla SSL compartida.

## Túnel SSH

La pestaña **Túnel SSH** convierte la conexión en tunelizada: HuginnDB abre un
listener local, lo reenvía a `(host, puerto)` por un canal SSH `direct-tcpip` y
apunta el driver a `127.0.0.1`. La base de datos no necesita configuración alguna
para esto.

- La **autenticación** es por contraseña o por fichero de clave privada (con
  passphrase opcional). Cualquiera de los dos secretos va al llavero, en una
  cuenta con espacio de nombres propio para que no pueda colisionar con la
  contraseña de la base de datos.
- **Puerto local** a `0` (Auto) deja que el sistema operativo elija un puerto
  libre. Si fijas uno y ya está ocupado, HuginnDB usa uno efímero para esa sesión
  en lugar de fallar la conexión — el perfil guardado no se toca.
- La **verificación del host SSH** es *confiar en el primer uso* por defecto: una
  clave desconocida se registra y, a partir de ahí, una clave **cambiada** se
  rechaza. **Estricta** exige una huella que ya hayas aceptado; **Aceptar
  cualquiera** se salta la comprobación y renuncia a la protección contra MITM.
  Las huellas aceptadas viven en `known_hosts.json` y el diálogo puede olvidar
  una.
- No está disponible para SQLite (un fichero local no tiene a dónde tunelizar) ni
  para `mongodb+srv://` (un registro SRV resuelve a varios hosts del replica set,
  y un túnel solo puede dar frente a uno — usa una URI directa
  `mongodb://host:puerto` para tunelizar MongoDB).

## Límites de conexiones

**Ajustes → Conexiones** gobierna cuántas conexiones mantendrá HuginnDB — y
muestra arriba cuántas hay abiertas ahora mismo. Conviene recordar que otros
clientes de la misma máquina (los orígenes de datos de un IDE, el pool de una
aplicación, un sidecar `huginndb-mcp`) cuentan también contra los límites *del
servidor*, aunque HuginnDB no los vea:

| Preferencia | Qué acota |
| --- | --- |
| Máximo de conexiones por servidor | El **total** contra un servidor, compartido por todas las conexiones y vistas de base de datos que lleguen a él. |
| Máximo de conexiones por vista de base de datos | El techo de cada pool por base de datos. Son los pools que se multiplican al explorar, así que es bajo a propósito. |
| Máximo de vistas de base de datos abiertas | Cuántas vistas puede mantener una conexión a la vez; las que llevan más tiempo sin usarse se cierran al pasar de aquí. `0` es sin límite. |
| Cerrar vistas inactivas tras | Segundos que una vista puede pasar sin usarse antes de cerrar su pool. Se reabre sola la próxima vez. `0` desactiva el cierre. |
| Intervalo de keepalive | Segundos entre pings de comprobación — ver más abajo. `0` apaga el latido. |
| Tiempo máximo de operación | Segundos que puede tardar una lectura de esquema — listar bases de datos y tablas, describir una relación, el ping de comprobación. Nunca una consulta que lances tú. |

Los límites se aplican al *abrir* un pool; los ya abiertos conservan lo que se
les concedió, así que reconecta para aplicar un cambio al momento. Y cuando se
agota el presupuesto de un servidor, abrir otra conexión o vista de base de datos
cierra primero la vista de ese servidor que hace más tiempo que no usas, en
lugar de fallar.

### Conexiones reservadas y abiertas

Cada servidor de **Ajustes → Conexiones** muestra dos números, por ejemplo
`2 abiertas · 7 de 10 reservadas`. Miden cosas distintas:

- **Abiertas** es lo que cuenta el propio servidor: las conexiones que HuginnDB
  tiene contra él ahora mismo. Los pools abren conexiones cuando una consulta
  necesita una y las cierran tras cinco minutos sin uso, así que este número se
  mueve con lo que estés haciendo.
- **Reservadas** es lo máximo que esas conexiones *pueden* llegar a crecer. Cada
  pool reclama un techo del presupuesto del servidor al abrirse, y ese
  presupuesto (el segundo número) es lo que impide que HuginnDB supere nunca el
  límite que fijaste, por muchas conexiones y vistas de base de datos que
  lleguen a ese servidor.

Así que `7 de 10 reservadas` con `2 abiertas` es normal: HuginnDB se ha
prometido hasta siete conexiones contra ese servidor y está usando dos.

Cómo se reparte el presupuesto:

- La **primera** conexión a un servidor reserva 5, lo que deja sitio a sus
  vistas de base de datos.
- Cada conexión **adicional** al mismo servidor — otro perfil que apunta al
  mismo host y puerto — reserva la mitad de lo que quede, nunca menos de 2. Con
  el presupuesto por defecto de 10 eso da 5, 2 y 2: tres conexiones a un
  servidor en vez de dos.
- Una **vista de base de datos** (una base de datos que has desplegado en una
  conexión de servidor completo) reserva 2 propias en los servidores SQL. Las
  vistas de MongoDB comparten el cliente de su conexión y no reservan nada.
- Una conexión abierta para el **conector MCP** reserva 2.

El techo de un pool queda fijo al abrirse, por eso el reparto se decide al
conectar. Si se agota el presupuesto de un servidor, sube **Máximo de conexiones
por servidor** (o el límite propio del perfil) y reconecta.

El driver de MongoDB mantiene además una o dos conexiones de monitorización por
servidor fuera de su pool. Esas no se cuentan, así que el servidor puede ver un
par más de las que muestra **abiertas**.

Un solo servidor puede llevar además su propio techo: **Máximo de conexiones para
este servidor**, en el diálogo de conexión, pisa la preferencia global solo para
ese perfil. La capacidad de conexiones es un hecho del servidor, no de tu sesión,
y por eso se guarda en el perfil: así viaja con él a las exportaciones, a los
orígenes compartidos y al conector MCP.

**Tiempo máximo de operación para este servidor** funciona igual, y existe por lo
mismo. Una lectura de esquema lleva un tope para que un socket muerto se reporte
en vez de dejar el árbol girando para siempre, pero ese tope es una suposición
sobre un servidor que nunca hemos visto — y en uno grande es la suposición
equivocada. Un SQL Server con varios cientos de bases de datos puede tardar más
que el valor por defecto solo en listarlas, y entonces el fallo se lee como una
conexión rota aunque se haya abierto en menos de un segundo. Súbelo en esa
conexión y deja el resto como está. En blanco significa «usa la preferencia
global».

Nunca limita una consulta que lances **tú**: ese tiempo es tuyo, y el tope solo
cubre las lecturas de metadatos que la app hace por su cuenta. Igual que el techo
de conexiones, viaja con el perfil — y a diferencia de los interruptores de MCP,
Pulse e IA, la actualización de un origen compartido **sí** lo trae, porque
cuánto tarda un servidor en responder es algo que quien publica ese servidor sabe
y que si no habría que redescubrir en cada máquina.

En la misma sección hay otro interruptor: **Compartir pools con el conector MCP**
permite que un sidecar `huginndb-mcp` en ejecución use las conexiones de esta app
en lugar de abrir las suyas, de modo que toda la máquina comparta un presupuesto
por servidor. Abre un listener en localhost protegido por token y está desactivado
por defecto — ver [`MCP.es.md`](MCP.es.md).

## Keepalive y conexiones perdidas

Una conexión inactiva la puede cortar sin avisar un NAT, un balanceador o un
cortafuegos corporativo. HuginnDB se defiende de eso por capas:

- **Un latido** hace ping periódicamente a cada conexión de primer nivel
  (**Ajustes → Conexiones → Intervalo de keepalive**; `0` lo desactiva). Eso
  mantiene la conexión en uso y detecta las caídas que no puede evitar.
- **Cada conexión se comprueba antes de que una consulta la use.** La que no
  responde en cinco segundos se descarta y se sustituye por una nueva, así que
  una consulta tras una pausa larga recibe una conexión que funciona en vez de
  un error.
- **Los túneles SSH se mantienen vivos solos**, con su propio keepalive cada 30
  segundos. Si aun así la sesión de un túnel se cae, se reconecta sola la
  siguiente vez que se usa, volviendo a verificar la clave del servidor.

Cuando un ping falla, se reintenta dos veces antes de dar la conexión por
perdida, así que una VPN que se reconecta o un portátil que sale de suspensión
no lanzan una alerta. Una conexión perdida se marca en la lista de conexiones y
en la barra de estado, con **Reconectar** en un clic. Además se sigue
comprobando cada 30 segundos y, cuando vuelve a responder — normalmente sola,
porque las conexiones muertas se sustituyen y los túneles se reconectan —, el
aviso desaparece y se te informa de que la conexión ha vuelto.

Las vistas por base de datos no se pinguean aparte. Usan la misma conexión — y
el mismo túnel SSH — que su padre, y se reabren solas.

### Editar una conexión que está abierta

Guardar cambios en una conexión abierta no la cierra: eso cortaría una
consulta en marcha y perdería las ediciones del grid que no hayas guardado.
Cuando el cambio es *adónde* se conecta — host, puerto, base de datos,
usuario, SSL, el túnel SSH o la cadena de conexión —, la sesión abierta sigue
usando los datos anteriores, así que la conexión se marca en ámbar en la lista
de conexiones y en la barra de estado, en todas las ventanas, con el mismo
**Reconectar** en un clic. Renombrarla, moverla de grupo o cambiar sus ajustes
de MCP, Pulse o IA no necesita reconectar y no marca nada. Pulsar **Conectar**
en el diálogo de conexión después de editarla la reconecta en el momento.

## Abrir una conexión desde la línea de comandos

| Flag | Significado |
| --- | --- |
| `--connect-profile <nombre>` | Conecta un perfil guardado por nombre visible. |
| `--connect-profile-id <id>` | Igual, por id de perfil — sin ambigüedad si dos perfiles comparten nombre. |
| `--host`, `--port`, `--database`, `--username` (`--user`) | Conexión ad-hoc, sin perfil guardado. |
| `--password` (`--pass`) | Opcional. Pisa la contraseña guardada de un perfil, o aporta una para una conexión ad-hoc. |
| `--driver <nombre>` | `postgres`, `mysql`, `sqlite`, `mongodb`, `sqlserver` — más los alias habituales (`postgresql`, `pg`, `mariadb`, `mssql`, `azuresql`, …). |
| `--connection-string` / `--uri` | URI completa. Es la vía principal para MongoDB, e implica `--driver mongodb` si no se indica driver. |
| `--auth-source` | Base de autenticación de MongoDB, para la forma ad-hoc sin URI. |
| `--name` | Nombre visible de la conexión ad-hoc. |

Funcionan tanto `--flag valor` como `--flag=valor`, y el valor se parte en el
*primer* `=`, así que una contraseña que contenga uno sobrevive.

Una conexión ad-hoc es **efímera por construcción**: vive en memoria para que el
explorador y las pestañas la traten como cualquier otra, pero se filtra al
guardar los perfiles, y una `--password` dada así se pasa directamente a la
llamada de conexión — nunca llega a `profiles.json` ni al llavero. Cierras la app
y desaparece.

Lanzar la app una segunda vez no abre una segunda app: los argumentos se
reenvían a la instancia en ejecución, que conecta en la ventana que ya tienes.

## Exportar e importar

**Archivo → Exportar perfiles…** escribe un `.json` a partir de una lista de
conexiones con casillas. **Incluir contraseñas (cifradas)** añade cada secreto —
tanto la contraseña de la base de datos como el secreto SSH — cifrado con
AES-256-GCM bajo una clave derivada de tu passphrase (PBKDF2-HMAC-SHA256, 600 000
iteraciones). Cada secreto lleva su propio salt y nonce, así que una entrada
corrupta no se lleva por delante el resto del fichero. La passphrase no se guarda
en ningún sitio y no se puede recuperar.

**Archivo → Importar perfiles…** lo lee de vuelta. Los conflictos se detectan por
**id** de perfil, no por nombre — una conexión renombrada en cualquiera de los
dos lados sigue siendo la misma conexión — y cada uno se resuelve por separado
como **Sobrescribir**, **Omitir** o **Mantener ambas**. Un perfil importado de un
fichero exportado *sin* contraseñas llega sin ella, y el resumen de la
importación lo dice: ponla antes de conectar.

Una advertencia específica de MongoDB. El fichero exportado lleva todos los
campos del perfil tal cual, `connection_string` incluida, y esa cadena **no** se
cifra — solo se cifran los secretos del llavero. Una URI construida por el
formulario no incrusta la contraseña, así que no pasa nada; una URI que hayas
editado a mano para incluir `usuario:contraseña@` viajaría en texto plano. Quita
las credenciales de la URI antes de exportar, o trata el fichero como un secreto
en sí mismo.

## Orígenes compartidos

**Ajustes → Orígenes** es la versión para varias personas de la importación: en
lugar de pasarse ficheros, alguien mantiene un bundle exportado en una ruta que
todo el mundo ya tiene montada — un recurso UNC, una unidad de red, una carpeta
sincronizada — y el resto lo registra como **origen** y tira de ahí.

- No hay protocolo ni servicio. Leer un origen es leer un fichero, y la ACL del
  recurso compartido es el control de acceso. Si el fichero está cifrado, su
  passphrase va a tu llavero (nunca a disco) y viaja fuera de banda: quien
  mantiene el recurso te la dice.
- Conviene tener claro qué compra ese cifrado: acceso de lectura al recurso
  **más** la passphrase entrega todas las contraseñas del fichero. La ACL es el
  perímetro real. Ver [`SECURITY.md`](../SECURITY.md) (en inglés).
- Una conexión importada de un origen es **de solo lectura en la app**: es una
  copia de la entrada de otra persona, y editarla en local la deshacería la
  siguiente sincronización. Para variarla, duplícala: la copia es una conexión
  local normal. La única excepción es la máquina que publica ese origen: puede
  corregir la conexión en el sitio (una contraseña mal puesta, sobre todo) y
  volver a publicarla desde el editor del documento — sin duplicados, mismo id.
- El registro es global — un registro por fichero, visible desde todos los
  entornos — y HuginnDB solo *lee* un origen salvo que lo marques
  explícitamente como uno que publica esta máquina.
- Cuando quien lo mantiene deja de publicar una conexión que ya te habías
  traído, no se borra a tus espaldas. Se marca y decides tú: **Conservar como
  mía** (pasa a ser una conexión local y editable) o **Eliminar** (que quita
  también su contraseña de tu llavero).

### Elegir qué traerse

Un fichero publicado puede llevar tres cosas independientes: las **conexiones**,
los **entornos** que las agrupan y la biblioteca de **esquemas JSON** con sus
vínculos a columnas. Te suscribes a cada una por separado, por origen, al
registrarlo y en cualquier momento después desde **Editar registro**.

Esa es la respuesta al reparto habitual dentro de un equipo: hay quien quiere
que le den la configuración entera y quien ya tiene sus entornos montados a su
gusto y solo quiere los servidores. Ambos registran *el mismo fichero* y marcan
casillas distintas — y ahí está la gracia, porque la alternativa es que quien lo
mantiene lleve una segunda copia solo con conexiones que nada mantiene al día
respecto a la primera.

El formulario muestra lo que lleva el fichero antes de que elijas, así que
suscribirse a «entornos» no es adivinar si publica alguno. Un bundle de
conexiones normal solo ofrece la primera casilla, porque es lo único que puede
aportar.

Hay dos combinaciones permitidas que conviene entender, y el formulario lo
advierte:

- **Entornos sin conexiones** se replican con una lista de miembros que nombra
  servidores que este equipo no tiene, así que se ven vacíos.
- **Esquemas JSON sin conexiones** llegan con sus vínculos desactivados, porque
  un vínculo que nombra una conexión desconocida se desactiva por diseño (ver
  [`JSON_SCHEMAS.es.md`](JSON_SCHEMAS.es.md)).

**Desmarcar una casilla no borra nada.** Lo que una suscripción más amplia ya
trajo se queda donde está, sigue vinculado al origen y sigue siendo de solo
lectura, y simplemente deja de actualizarse. Liberarlo como entradas locales
normales es un paso aparte y deliberado — y sin vuelta atrás, porque una
conexión que has desvinculado es tuya a partir de entonces y el origen no la
vuelve a adoptar.
