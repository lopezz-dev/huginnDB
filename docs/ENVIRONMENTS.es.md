# Entornos

Un **entorno** es un conjunto con nombre de conexiones más toda la sesión de
trabajo que les pertenece: qué pestañas tienes abiertas, cómo están divididos los
paneles, qué conexión tiene el foco y qué se reconecta cuando vuelves a él.

El selector está en la barra superior, a la izquierda de la ruta. Elige otro
entorno y HuginnDB guarda la sesión actual, cierra las conexiones abiertas y
levanta la del otro — las pestañas que tenías, colocadas como las dejaste, y
filtradas y ordenadas como las dejaste.

El caso para el que existe: trabajas con varios clientes o sedes, cada uno con su
puñado de servidores. Antes, mantenerlos separados significaba una ventana por
cliente y reconstruir la distribución a mano cada mañana. Ahora es un selector.

## Qué posee un entorno y qué no

**No posee tus conexiones.** Hay una única lista global de conexiones, igual que
antes. Un entorno decide cuáles están *en juego*; no se apropia de ellas.

Esa distinción es lo que hace que eliminar uno sea seguro. Eliminar un entorno
descarta las pestañas que recordaba y su distribución de paneles. No elimina
ninguna conexión y no toca ninguna contraseña guardada: eso vive en
`profiles.json` y en el almacén de credenciales de tu sistema operativo, ambos
fuera del entorno. El diálogo de confirmación lo dice, porque «eliminar entorno»
se puede leer perfectamente al contrario.

La dirección inversa **sí** se propaga: eliminar una **conexión** la quita de
todos los entornos que la recordaban. Si no, volvería como una pestaña apuntando
a una conexión que ya no existe en cuanto cambiaras de entorno.

## Qué recuerda cada entorno

- Las pestañas de tabla y de consulta abiertas, con su color y si estaban fijadas.
- En las pestañas de tabla: los filtros de columna, la ordenación multinivel y la
  búsqueda que confirmaste. Solo lo que estaba realmente aplicado — una búsqueda
  a medio escribir no se guarda.
- La disposición de los paneles del espacio de trabajo (divisiones y flotantes).
- Qué conexiones estaban activas, cuál tenía el foco y qué pestaña se mostraba.
- Qué nodos tenías desplegados en el árbol de esquema y qué conexiones tenías
  plegadas en él. La fila de una conexión está abierta siempre que la conexión lo
  esté, así que solo hace falta recordar tus pliegues.

Las pestañas del editor de estructura y del editor de vistas **no** se recuerdan a
propósito: son sesiones de edición en curso, no sitios a los que vuelves.

Cada entorno recuerda las 20 conexiones más recientes de forma independiente. El
tope es por entorno a propósito: uno global permitiría que un entorno muy usado
desalojara sin avisar las pestañas de otro que llevabas tiempo sin abrir.

## Orígenes compartidos

Un entorno también puede obtener sus conexiones de otro sitio: un **origen
compartido** es un fichero en una ruta a la que tu máquina ya llega — un recurso
UNC, una unidad mapeada, una carpeta sincronizada — del que HuginnDB importa
conexiones, contraseñas incluidas. La idea es que quien se incorpora a un equipo
no configure nada a mano.

Publicar uno es simplemente «Exportar perfiles» con passphrase y dejar el
resultado en la carpeta compartida. Consumirlo se hace en Ajustes → **Orígenes
compartidos**: se le da la ruta, se escribe la passphrase una vez y las conexiones
aparecen. La passphrase se queda en tu propio almacén de credenciales, una por
origen, y nunca se escribe en disco. El registro es **global**, no parte de un
entorno concreto: un origen describe un fichero en un recurso compartido, no un
eje Producción/Staging, y lo que produce — conexiones, entornos espejados
enteros — también es global.

Para todo el que lo consume solo va en un sentido. HuginnDB lee esa ruta, y una
conexión que viene de un origen es de solo lectura: la siguiente sincronización
desharía un cambio local de todas formas. Si necesitas una variante, duplícala; la
copia es tuya, editable por completo y ya sin vínculo con el origen. La única
excepción es la máquina que publica el origen: puede corregir una conexión — una
contraseña mal puesta, sobre todo — en el mismo diálogo, con el mismo id, y
volver a publicarla desde el editor del documento cuando esté lista; sin
duplicados ni nada que limpiar después.

El color, el icono, el nombre y el tema de un entorno son distintos: siempre
puedes personalizarlos localmente, incluso mientras el entorno sigue espejado —
abre su diálogo de renombrar, elige lo que quieras, y se recuerda solo en este
equipo. La siguiente sincronización mantiene todo lo demás del entorno (qué
conexiones agrupa) al día con el origen, y un botón "volver a seguir al origen"
descarta tu personalización si cambias de idea.

### Curarlo (1.19.0)

Si eres quien publica el fichero, marca el origen como uno que **publica este
equipo** (Ajustes → Orígenes compartidos → editar el registro). Es un
interruptor deliberado y reversible, y es lo único que permite a HuginnDB
escribir en esa ruta: todos los orígenes empiezan sin él, así que actualizar la
aplicación nunca lo concede. Tu sistema operativo sigue teniendo la última
palabra: el editor prueba la ruta con una escritura real y se abre en modo
lectura si el recurso la rechaza, en vez de dejarte componer una revisión y
fallar en el último paso.

A partir de ahí, «Editar el documento» abre un editor a pantalla completa del
propio fichero:

* **Conexiones** — dos columnas: este equipo a la izquierda, el fichero a la
  derecha. Nada de lo que hagas aquí toca tus propias conexiones; pasar una a la
  derecha la copia al documento. Cada fila publicada dice cómo viaja su
  contraseña: sin tocar (lo barato y lo normal), cifrada desde tu llavero, o sin
  contraseña, en cuyo caso la pedirá el otro lado.
* **Entornos** — el aspecto y la pertenencia que publica cada uno. Una conexión
  que no esté en ningún entorno se publica igual: solo queda suelta.
* **JSON Schemas** — el trozo de biblioteca y las reglas que viajan con él, para
  que un solo fichero deje un equipo listo.
* **Publicación** — quién cura el fichero, una nota de revisión, la frase de paso
  y el informe de abajo.

Antes de escribir nada te dice qué provoca publicar en todo el que sincroniza:
qué se añade, qué cambia de verdad, qué desaparece — y, cuando toca, que un lote
de bajas es lo bastante grande como para que **nadie reciba aviso** (ver la regla
de «esta lectura no es de fiar» más abajo; un publicador que cruza esa línea deja
en silencio a todo el equipo con conexiones que ya no existen). También pone
precio a las contraseñas: una contraseña que no ha cambiado viaja byte a byte, así
que renombrar un entorno no le cuesta nada al equipo, mientras que rotar la frase
de paso lo recifra todo y obliga a todos a derivar una clave por contraseña en su
siguiente sincronización.

El fichero se escribe de forma atómica, dejando la revisión anterior al lado como
`<nombre>.json.bak`, y el editor compara el contenido del fichero al publicar: si
alguien ha publicado mientras lo tenías abierto, tu revisión se rechaza y se te
enseña la suya en vez de pisarla.

Los orígenes se sincronizan al arrancar HuginnDB, cada pocas horas y cuando pulses
**Sincronizar ahora**. Un cambio de metadatos (un host o un puerto que se han
movido) de una conexión que tengas abierta espera a que la cierres: repuntar una
conexión viva a mitad de consulta te llevaría en silencio a otro servidor.

**Una sincronización nunca borra nada por su cuenta.** Si una conexión deja de
aparecer en el fichero, recibes un aviso que se queda ahí — en el árbol de esquema
y en Ajustes, no un diálogo que te interrumpa — con dos opciones: conservarla como
tuya, lo que la desvincula del origen y la vuelve editable, o borrarla junto con su
contraseña guardada. Tu decisión se recuerda. Que otra persona edite el fichero
compartido no puede quitarte credenciales de tu máquina.

Hay dos situaciones que se tratan a propósito como «esta lectura no es de fiar»: un
fichero que no se puede leer o interpretar (recurso caído, VPN cortada, el
publicador guardándolo justo en ese momento) no cambia absolutamente nada, y un
fichero que ha perdido limpiamente la mitad de las conexiones de un origen de golpe
no avisa de nada hasta que lo revises. Si no, cualquiera de los dos casos te
enterraría en avisos de baja de conexiones que están perfectamente vivas.

Conviene ser claro con la seguridad de esto, porque el cifrado puede llevar a
engaño: cualquiera que pueda leer la carpeta **y** tenga la passphrase tiene todas
las contraseñas de ese fichero. La passphrase tiene que llegar a la gente por otra
vía, así que la protección que de verdad cuenta son los permisos de la carpeta.
Trata un fichero de origen como un almacén de credenciales. `SECURITY.md` en el
repositorio lo detalla.

Quitar un origen olvida su passphrase guardada. Las conexiones que importó se
quedan: a esas alturas ya son tuyas, y borrarlas no es algo que deba hacer quitar
un marcador.

## Cambiar de entorno no es instantáneo

Un cambio cierra todos los pools abiertos y abre los del entorno que entra. Tarda
más o menos lo que tarde conectar a esos servidores, y el selector muestra un
indicador de progreso y rechaza más clics mientras trabaja. Es trabajo real, no
una transición visual: si un servidor tarda en responder, el cambio tarda.

Una conexión que no consiga volver (host inalcanzable, contraseña que ya no está
en el almacén de credenciales) se salta sin bloquear al resto, igual que al
arrancar.

La reconexión al entrar respeta la preferencia **Reconectar al arrancar**. Con ella
desactivada, cambiar de entorno sigue cambiando cuál está activo y sigue
registrando lo que tenías abierto, pero no reabre conexiones ni restaura la
distribución — la restauración del layout va deliberadamente unida a la
reconexión.

## La actualización desde una versión anterior

No se pierde nada. La sesión que tuvieras se convierte en un entorno único que la
contiene tal cual, así que el primer arranque tras actualizar se ve igual que el
último antes de hacerlo. A partir de ahí puedes renombrarlo y añadir más.

Ese primer entorno nace **sin nombre** y se muestra como «Predeterminado» en el
idioma que tenga la interfaz. Es deliberado: si HuginnDB escribiera un nombre
dentro de tus datos, se quedaría en un solo idioma para siempre. Ponle nombre y el
nombre es tuyo.

Algo que conviene saber antes de actualizar: el fichero de sesión
(`tab_state.json`) pasa a un formato nuevo y **una versión anterior de HuginnDB no
lo va a entender**. Volver a una versión previa significa que arranca con la
sesión vacía — tus conexiones y contraseñas siguen intactas, pero las pestañas y
la distribución recordadas no son legibles para ella. Si quieres probar una
preliberación sin ese riesgo, la versión canary guarda su estado de sesión en un
directorio propio, conviviendo con tu instalación estable (ver `docs/CANARY.md`
en el repositorio).

## Ventanas secundarias

Los entornos pertenecen a la ventana principal. **Ventana → Nueva ventana** abre
una instancia deliberadamente efímera: nunca escribe estado de sesión, así que al
cerrarla pierde sus pestañas por diseño. Cambiar de entorno en la ventana
principal no molesta a una secundaria abierta.

Para seguir trabajando en tu entorno actual y abrir otro al lado, haz clic
derecho en ese entorno del rail y elige **Abrir entorno en una ventana nueva**.
La ventana nueva muestra las conexiones y los filtros de base de datos de ese
entorno y reconecta las conexiones que tenía abiertas (reutilizando un pool que
la ventana principal ya tenga, así que nada se abre dos veces). Las pestañas y la
disposición de paneles no se trasladan — pertenecen a la ventana principal — y
nada de lo que haga la ventana nueva cambia en qué entorno está la principal ni
qué se reabre al arrancar.

## Notas prácticas

- Renombrar a vacío borra tu nombre y devuelve el predeterminado localizado.
  Crear un entorno sí exige un nombre: uno nuevo sin nombre sería indistinguible
  del predeterminado.
- Un entorno se dibuja con las iniciales de su nombre sobre su color de acento,
  o con una imagen de avatar propia si le asignas una (elige un archivo, o
  suéltalo sobre la vista previa del diálogo de crear/renombrar). Ambos son
  cosméticos; nada se comporta distinto. La imagen se guarda dentro del propio
  entorno, recortada en cuadrado y reducida a 128px, así que se copia al
  replicarlo y se descarta al eliminarlo — no hay ningún archivo aparte que
  gestionar.
- El último entorno no se puede eliminar. Siempre hay exactamente uno activo.
