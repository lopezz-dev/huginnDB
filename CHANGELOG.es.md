# Registro de cambios

Todos los cambios relevantes de HuginnDB se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es/1.1.0/) y el proyecto se adhiere a [Versionado Semántico](https://semver.org/lang/es/) a partir de la `1.0`.

> Nota: este archivo es la traducción al español de `CHANGELOG.md`. Cubre las versiones recientes; las versiones más antiguas se muestran en inglés dentro de la app hasta que se traduzcan.

## [Sin publicar]

### Añadido

- **`run_script` en el conector MCP: un script SQL entero en una sola sesión,
  tablas temporales y migraciones incluidas.**
  - El resto de herramientas toma la sesión del pool que esté libre, así que
    una tabla temporal creada en una llamada no estaba en la siguiente, y el
    `SELECT` que debía comprobar un paso nunca podía verla. Un asistente al que
    se pidió ejecutar una migración con HuginnDB concluyó que «no soporta
    tablas temporales ni lotes» y reescribió el script en sentencias sueltas.
  - **`run_script`** ejecuta el script en orden en **una sola sesión**: las
    tablas `CREATE TEMPORARY TABLE` / `#temp`, los `SET` y las variables pasan
    de una sentencia a la siguiente, y cada `SELECT` del script devuelve sus
    filas en la misma respuesta, marcadas con su sentencia y su línea.
  - **Una transacción por defecto**: o entra todo o nada, y un fallo nombra la
    sentencia y su línea. `transaction: false` ejecuta el script tal cual,
    con su propio `BEGIN`/`COMMIT`. En MySQL, donde un cambio de esquema hace
    commit implícito, esas sentencias necesitan `transaction: false`.
  - El script va en línea o como **ruta de un fichero `.sql` local** que lee el
    propio conector: una migración grande no pasa nunca por la conversación, y
    los ficheros UTF-16 de SQL Server Management Studio y sus separadores `GO`
    funcionan tal como se guardaron. Hasta 10 000 sentencias y 16 MB por
    llamada.
  - La sesión **se cierra al terminar**, así que nada de lo que montó el script
    se cuela en la siguiente llamada ni en la rejilla de la app.
  - Necesita la política de escritura MCP de la conexión en `data`; cualquier
    cambio de esquema, tablas temporales incluidas, necesita `full`.
    PostgreSQL, MySQL, SQLite y SQL Server; MongoDB se rechaza (usa
    `run_writes`). Queda en el registro de auditoría MCP y una política
    gestionada lo limita igual que a `run_write`.
  - Las instrucciones del conector ahora dirigen a la IA a esta herramienta
    para migraciones y scripts de varios pasos.

- **Conector MCP: un límite de filas por conexión.**
  - Cuántas filas entrega una llamada a un cliente de IA (`run_query`,
    `run_queries`, `browse_table`, la lista `verify` de `run_writes`) es ahora
    un ajuste en vez de una constante de línea de comandos: un valor por
    defecto en **Ajustes → MCP → Límites → Filas por llamada**, y un número
    junto a cada conexión en el mismo panel para la que tenga filas
    especialmente anchas o especialmente ligeras. Vacío sigue el valor por
    defecto. Ambos se leen en cada llamada, así que un cambio surte efecto sin
    reiniciar el cliente de IA.
  - El límite por conexión es local, como el nivel de escritura: una
    sincronización de un origen compartido conserva el tuyo.
  - **Un resultado recortado ahora lo dice con palabras.** Además de
    `"truncated": true` lleva `row_limit` y un `notice` que nombra el límite,
    el ajuste que lo fijó y qué hacer en su lugar (agregar, filtrar o paginar),
    para que el modelo deje de dar por completa una respuesta parcial. Una
    página de `browse_table` acotada por el límite da el `offset` de la
    siguiente.
  - `list_connections` informa del límite de cada conexión como `max_rows`,
    para que el asistente dimensione una consulta antes de lanzarla.
  - **Una política gestionada puede ponerle techo**: `mcpMaxRows` en un rol
    rebaja a él el límite de cada persona y nunca sube ninguno. Actualiza todas
    las instalaciones antes de añadirlo: un HuginnDB anterior da un campo
    desconocido por política no válida.

- **Recuento exacto en el pie de la tabla.** Cuando el total del pie es una
  estimación del motor (`~N`: `estimatedDocumentCount` de MongoDB,
  `reltuples` de Postgres, `TABLE_ROWS` de MySQL, las estadísticas de
  partición de SQL Server), un botón **Σ** a su lado cuenta de verdad todas
  las filas, respetando los filtros, la búsqueda y la expresión del panel de
  consulta activos. También aparece cuando el recuento de fondo se rinde —en
  MongoDB un recuento filtrado se corta a los diez segundos— y este no tiene
  ese límite: lo has pedido tú, así que dura lo que duraría una consulta que
  escribieras. La cifra exacta se mantiene hasta que un cambio de filtro o
  una actualización la sustituyen, y una respuesta que llegue después de
  cualquiera de los dos se descarta.

### Cambiado

- **Los separadores entre grupos de las barras son un solo componente, con dos
  alturas.** Las líneas finas que separan grupos de controles —en la barra de
  título, la barra de herramientas del grid, su fila de chips y su pie, la
  barra del editor de consultas y la consola— y la del título de una pestaña
  eran doce copias escritas a mano con cuatro alturas distintas. Ahora son un
  único `Separator`: 16 px entre controles, 12 px entre trozos de texto
  pequeño y los mismos 8 px a cada lado entre grupos de una barra. Los de la
  consola quedan algo más bajos y los de la fila de chips algo más altos y
  ajustados que antes; nada más cambia de sitio.

- **Conector MCP: el límite de filas por defecto es 200, antes 1000.** Mil
  filas de una tabla corriente son varias veces los 25 000 tokens que Claude
  Code acepta en un resultado de herramienta MCP, así que el valor anterior
  producía un resultado que el cliente descartaba en vez de uno más corto que
  el modelo pudiera usar. `--max-rows` sigue funcionando, ahora como valor por
  defecto de ese cliente; una conexión con límite propio lo conserva.

### Corregido

- **Los números de fila siguen contando entre páginas.** Al recorrer una tabla
  o colección página a página, la columna de número de fila de la rejilla (y
  el número de cada tarjeta en la vista de lista) volvía a empezar en 1 en
  cada página, así que la página 2 con 100 filas por página mostraba 1–100 en
  vez de 101–200 y no coincidía con el rango del pie ni con **Ir a la fila**.
  Ahora son absolutos. El número es solo de visualización: seleccionar,
  editar, copiar y borrar filas sigue identificando cada fila por sus valores,
  nunca por su posición (ADR #7).

## [1.36.0] — 2026-10-27

### Añadido

- **Bloqueo de la app: una contraseña maestra antes de que HuginnDB muestre
  nada.**
  - Actívalo en **Ajustes → Seguridad**. Todos los secretos que guarda
    HuginnDB salen del llavero del sistema y pasan a una bóveda cifrada que
    solo abre la contraseña maestra: contraseñas de las conexiones,
    contraseñas y frases SSH, frases de los orígenes compartidos, la clave de
    la IA y el token de GitHub del formulario de incidencias. Al desactivarlo
    vuelven al llavero tal como estaban.
  - **Nada detrás del muro.** Con la app bloqueada solo se ve la pantalla de
    bloqueo: ni conexiones, ni pestañas restauradas, ni árbol del esquema, y
    nada llega a una base de datos. El backend rechaza todos los comandos
    salvo el de desbloquear, haga lo que haga la interfaz.
  - **El conector MCP también queda cerrado.** Claude Desktop y los demás
    clientes reciben "HuginnDB is locked: open the HuginnDB app and unlock it"
    hasta que desbloquees; el conector no puede abrir la bóveda por su
    cuenta.
  - Se bloquea en cada arranque, tras 15 minutos sin actividad (configurable,
    o nunca), con **Ctrl+L** y cuando se bloquea la sesión: Win+L, o al
    desconectarte del Escritorio remoto, que deja la sesión abierta en el
    servidor (en Linux, el bloqueo de sesión de logind). Consulta el ADR
    #119. Al bloquearse se cierran las demás ventanas,
    todas las conexiones y túneles SSH, y se borra la conversación del panel
    de IA; al desbloquear no se reconecta nada.
  - Tras tres contraseñas incorrectas, cada intento espera más, hasta cinco
    minutos.
  - **La pantalla de bloqueo es un candado con el estilo de pegatina de
    HuginnDB**, animado para contar lo que pasa: se cierra de golpe al
    bloquearse la app, sus tres LEDs corren mientras se comprueba la
    contraseña, tiembla en rojo si es incorrecta, un anillo ámbar se vacía
    durante la espera y se abre antes de que aparezca la app. Con «reducir
    movimiento» activado en Windows conserva todos los estados sin moverse.
    Un aviso de Bloq Mayús aparece bajo el campo.
  - **La política gestionada puede exigirlo.** El `appLock` de un rol fija
    `required` (HuginnDB se abre en una pantalla que pide crear la contraseña
    maestra y el bloqueo no se puede desactivar), `maxIdleMinutes` y
    `lockWithSession`; `allowWindowsHello` se acepta y queda reservado. Una
    política solo endurece el bloqueo, nunca lo relaja, y una política que no
    se puede leer mantiene el bloqueo que haya. Actualiza todas las
    instalaciones antes de añadir `appLock`: las anteriores leen el campo como
    una política no válida. Consulta `docs/POLICY.es.md` y el ADR #120.
  - **Ajustes → Seguridad** lo reúne todo, con la misma estructura que el
    resto de secciones: el interruptor del bloqueo (activarlo o desactivarlo
    pide la contraseña maestra), las filas para cambiar la contraseña y
    bloquear ahora, y el tiempo de inactividad.
  - **Si olvidas la contraseña maestra, pierdes los secretos de la bóveda**, y
    la app lo avisa antes de activar el bloqueo. **¿Has olvidado la contraseña
    maestra?** en la pantalla de bloqueo restablece la bóveda: se borran los
    secretos, y tus conexiones se conservan y vuelven a pedir sus contraseñas.
  - Protege frente a alguien sentado en tu sesión de Windows abierta, también
    si borra los ficheros de HuginnDB. No protege frente a malware ni a un
    keylogger, y por ahora los nombres de las conexiones, el contenido de las
    pestañas y el historial de Pulse se siguen guardando sin cifrar. Consulta
    la nueva guía **Bloqueo de la app** y el ADR #118.

- **Pega un bloque de celdas en la tabla.**
  - Copia varias celdas de una hoja de cálculo, de otra tabla o de cualquier
    texto separado por tabuladores y pulsa Ctrl+V sobre una celda: el bloque
    cae con su esquina superior izquierda ahí y se extiende hacia la derecha y
    hacia abajo, por las columnas y filas tal como se ven. Las filas que pasan
    de la última se convierten en **filas nuevas**. Un valor sin tabuladores ni
    saltos de línea se sigue pegando en esa celda, como hasta ahora.
  - Antes de escribir nada, una confirmación dice cuántas celdas cambian y
    cuántas filas se añaden, muestra las primeras filas y nombra lo que se
    queda fuera y por qué: una columna de la clave primaria, una columna que
    bloquea la política de tu organización, una clave que genera la base de
    datos. **Pegar solo las celdas permitidas** escribe el resto. Un valor
    igual al que ya tiene la celda no se envía.
  - **Todo o nada**: el pegado entero es una transacción en PostgreSQL, MySQL,
    SQLite y SQL Server; si falla una celda, no cambia nada. En MongoDB es una
    transacción en un replica set; un servidor independiente no tiene
    transacciones, así que allí las escrituras van en orden y se paran en el
    primer error, y la confirmación lo avisa antes. Ver el ADR #114.

- **Política gestionada: limita qué columnas puede escribir un rol.**
  - Una regla puede decir ahora a qué columnas puede dar valor `insert` y
    cuáles puede modificar `update`: `"columns": { "insert": ["cliente",
    "importe", "estado"], "update": ["estado"] }`. Las personas del rol siguen
    leyendo la tabla entera; solo modifican esas columnas, y su IA nunca tiene
    más. Un verbo que no aparece en `columns` conserva todas las columnas, como
    hasta ahora. En MongoDB una columna es un campo de primer nivel.
  - **En la tabla**, una columna que una persona no puede ni modificar ni
    rellenar muestra un candado en la cabecera, una que solo puede rellenar al
    añadir una fila muestra una marca de «solo al añadir fila», y la línea sobre
    las filas nombra las que puede modificar. Una
    celda bloqueada se sigue abriendo, en solo lectura, para leer su valor;
    pegar, «Set NULL» y la actualización masiva la dejan fuera, y una fila nueva
    o duplicada la deja con su valor por defecto.
  - **En el editor de políticas**, `insert` y `update` tienen cada uno **Todas /
    Solo estas**, con las columnas de las propias tablas de la regla para
    elegir, marcadas cuando son obligatorias, las pone el servidor o faltan en
    alguna tabla. Avisa, con un botón que lo corrige, cuando una columna
    obligatoria se queda fuera de `insert` (no se podría añadir ninguna fila) y
    cuando `delete` convive con un `update` limitado (borrar una fila y volver a
    añadirla escribiría cualquier columna). **Ver como** y Ajustes → Política
    también muestran las columnas.
  - **Generar permisos** escribe permisos por columna —`GRANT UPDATE (estado)
    ON …`—, así que la base de datos hace cumplir los límites a quien entra con
    su propio usuario. SQL Server no tiene `INSERT` por columna, así que allí el
    script concede `INSERT` sobre la tabla y avisa de que `columns.insert` solo
    se cumple dentro de HuginnDB; MongoDB no tiene privilegios por campo.
  - Con un límite por columna, las sentencias libres `UPDATE`/`INSERT` se
    rechazan —el texto de una sentencia no dice qué columnas escriben sus
    triggers o vistas—, mientras que las lecturas libres siguen igual.
  - **Actualiza HuginnDB en todos los equipos antes de añadir `columns`**: las
    versiones anteriores leen una política con ese campo como rota y bloquean
    todas las conexiones. El editor lo avisa al guardar. Ver `docs/POLICY.md` y
    el ADR #113.
- **Añadir conexiones con ayuda de una IA, sin darle las llaves.** La guía del
  MCP (también en **Ayuda → Documentación**) tiene una sección nueva, *Añadir
  conexiones*, que documenta el fichero de importación de perfiles lo bastante
  bien como para que un asistente lo escriba: el bloque `meta`, los siete
  campos obligatorios, los opcionales y un perfil por driver (PostgreSQL, MySQL
  por túnel SSH, SQLite, MongoDB desde una URI, SQL Server).
  - Es la respuesta a «¿puede el conector crear conexiones?»: no, a propósito.
    Una herramienta que las creara dejaría al asistente decidir adónde se
    conecta HuginnDB, y la contraseña pasaría por la conversación. El asistente
    escribe un fichero sin secretos; tú lo importas con **Archivo → Importar
    perfiles…**, ves lo que añade y escribes cada contraseña en la app.
  - Lo importado se queda en local (publicarlo en un origen compartido sigue
    siendo decisión tuya) y no queda expuesto ni al conector MCP ni al panel de
    IA.
  - Un test del backend importa todos los ejemplos de la guía en inglés y en
    español, así que el formato documentado no puede separarse de lo que acepta
    el importador.

### Corregido

- **Un túnel SSH con clave RSA ya inicia sesión en servidores OpenSSH
  actuales.** El túnel firmaba siempre con `ssh-rsa`, que usa SHA-1 y que
  OpenSSH 8.8 y posteriores rechazan por defecto (`signature algorithm ssh-rsa
  not in PubkeyAcceptedAlgorithms`), así que cualquier bastión al día
  rechazaba una clave RSA. Ahora pregunta al servidor qué firmas acepta, como
  hace el cliente de OpenSSH, y firma con `rsa-sha2-512` o `rsa-sha2-256`.
  `ssh-rsa` solo se usa con un servidor que no acepta otra cosa. Las claves
  Ed25519 y ECDSA nunca se vieron afectadas.
- **Una conexión importada ya no pertenece a un origen compartido de otra
  máquina.** Una exportación de perfiles o de entornos lleva el id del origen
  compartido del que venía cada conexión en la máquina que exportó, y la
  importación lo conservaba. Ese id aquí no nombra nada, así que la conexión
  llegaba de solo lectura en el diálogo de conexión y aparecía como de un
  origen desaparecido. Ahora una conexión importada es una conexión local
  normal, como una creada por ti; solo la sincronización del propio origen
  compartido marca una conexión como suya.

### Seguridad

- **Dependencias al día tras una auditoría de seguridad.** Las que van
  dentro de la aplicación:
  - **La comprobación de certificados TLS** (todas las conexiones cifradas a
    bases de datos, el endpoint de IA y el actualizador) ya no confía en los
    certificados intermedios de emSign (eMudhra) retirados de confianza
    (RUSTSEC-2026-0381/0382/0383), e incorpora cuatro correcciones de
    `rustls`, entre ellas una degradación del intercambio de claves
    post-cuántico (RUSTSEC-2026-0349) y mensajes de handshake aceptados en la
    fase equivocada (RUSTSEC-2026-0285).
  - **SQL Server** usa ahora la misma pila TLS actualizada que el resto de
    bases de datos. Su driver pasa a tiberius 0.13, cuyas antiguas
    bibliotecas TLS ya no recibían correcciones. Las consultas siguen durando
    lo que necesiten: el nuevo driver corta cualquier consulta a los 30
    segundos por defecto, y HuginnDB lo desactiva.
  - **Tauri 2.12**, que corrige una forma de que una ventana leyera las
    respuestas IPC de otra (GHSA-w28w-mhc8-qvjv). Las ventanas de HuginnDB
    solo cargan su propia interfaz, así que no era alcanzable, pero la
    corrección ya está.
  - **Los túneles SSH** pasan a russh 0.65, que deja la biblioteca de claves
    bifurcada que arrastraba un `crypto-bigint` con canales laterales de
    tiempo (RUSTSEC-2026-0387). Las huellas de host guardadas siguen
    coincidiendo: un servidor con certificado de host de OpenSSH se sigue
    reconociendo por la clave con la que ya se confiaba en él, nunca por una
    autoridad que no hayas configurado. Ver ADR #117. El aviso Marvin del
    crate `rsa` (RUSTSEC-2023-0071) sigue apareciendo, porque no tiene versión
    corregida.
- Las herramientas de desarrollo (Vite 8, Vitest 5) resuelven 25 avisos que
  solo afectaban a las máquinas donde se compila la aplicación, no a la
  aplicación.
- Compilar HuginnDB desde el código declara ahora la versión de Rust que de
  verdad necesita, la 1.90; las dependencias ya la exigían desde hace tiempo.

## [1.35.0] — 2026-10-22

### Añadido

- **Herramientas de lote en el conector MCP: varias lecturas, o varias
  escrituras, en una sola llamada.**
  - Cada llamada a una herramienta es un turno del modelo de IA, y cada turno
    vuelve a pagar la conversación hasta ese punto. Un agente que cambiaba unas
    cuantas filas de configuración con un `run_write` por fila, y releía cada
    una para comprobarla, se gastaba casi todo el plan del usuario en idas y
    vueltas.
  - **`run_queries`** ejecuta una lista de sentencias de solo lectura y
    devuelve un resultado por sentencia, en orden. La que falla se informa en
    su propio hueco y las demás se ejecutan igual.
  - **`run_writes`** aplica una lista de escrituras de fila
    (`INSERT`/`UPDATE`/`DELETE`) en **una transacción**: o entran todas o
    ninguna. Una escritura puede indicar cuántas filas debe tocar
    (`expect_rows`), y si toca otro número se deshace todo el lote, lo que
    detecta el `UPDATE` cuyo `WHERE` no encontró nada. Las lecturas de
    `verify` se ejecutan tras el commit y vuelven en la misma respuesta, así
    que comprobar el resultado no cuesta otra llamada.
  - `run_writes` necesita que la política de escritura MCP de la conexión sea
    `data` o superior, admite hasta 50 escrituras y rechaza, explicando el
    motivo, los cambios de esquema, `BEGIN`/`COMMIT` y similares, y un
    `UPDATE`/`DELETE` sin `WHERE`. En MongoDB las escrituras se ejecutan en
    orden, sin transacción, y se paran en el primer fallo; la respuesta lo
    indica.
  - Las instrucciones del conector ahora le dicen a la IA que agrupe, así que
    usa estas herramientas sin que haya que pedírselo.

### Cambiado

- **Las respuestas del conector MCP gastan menos tokens.** Todas las
  herramientas respondían con JSON indentado, que pone cada celda de un
  resultado en su propia línea con sangría. Un cliente de IA mete ese espacio
  en blanco en su contexto y lo paga el plan del usuario: una página de 50
  filas ocupaba en torno a un 40 % más de lo necesario. Ahora las respuestas
  son JSON compacto, con el mismo contenido.

### Corregido

- **Un resultado recortado por el `--max-rows` del conector MCP ahora dice que
  se recortó.** Las filas se descartaban pero `truncated` seguía en `false`,
  así que la IA no distinguía una página de la tabla entera. En MongoDB los
  tipos por celda no se recortaban con las filas y dejaban de cuadrar con
  ellas.

## [1.34.0] — 2026-10-19

### Añadido

- **Un terminal en el panel inferior, con `mongosh` iniciado en tu conexión
  MongoDB.**
  - Cuando le pides a una herramienta de IA que compruebe algo en MongoDB,
    suele responder con un script de `mongosh` (variables, bucles,
    `printjson`) que el editor de consultas rechaza: admite una sentencia
    cada vez y nada de JavaScript. Ahora esos scripts se pueden pegar en
    `mongosh` dentro de HuginnDB y se ejecutan tal cual.
  - El icono de **Terminal** de la barra de actividad derecha (o
    `` Mod+Shift+` ``) lo abre junto a la Consola. Su menú **+** abre `mongosh`
    en la conexión MongoDB actual, en la base de datos de la pestaña en la que
    estabas, o tu propio shell: PowerShell 7 (si no, Windows PowerShell) en
    Windows, y tu `$SHELL` (si no, `bash`) en el resto. Cada sesión es una
    pestaña, y siguen en marcha con el panel plegado.
  - `mongosh` solo se ofrece mientras estás en una conexión MongoDB abierta.
    Sin conexión, con una SQL o con una MongoDB cerrada, el panel ofrece solo
    el shell y no dice nada de `mongosh`, ni siquiera que no está instalado.
  - `mongosh` inicia sesión con el usuario, la contraseña y el túnel SSH de la
    propia conexión, así que la conexión tiene que estar abierta antes. La
    contraseña se le pasa en el entorno de `mongosh`, nunca en su línea de
    comandos, y se borra antes de que aparezca el prompt. En Windows entra directamente
    en el prompt de la conexión, sin la pregunta por una cadena de conexión
    que hace `mongosh` cuando cree que lo han abierto con doble clic. Al desconectar se
    cierran las sesiones de `mongosh` de esa conexión.
  - `mongosh` no viene incluido. HuginnDB usa el que tengas instalado, que
    busca en el `PATH` o donde lo dejan los instaladores oficiales; Ajustes →
    **Terminal** muestra cuál ha encontrado y su versión, y admite una ruta.
  - **Si no hay ninguno, con un clic se descarga.** En una conexión MongoDB sin
    `mongosh` instalado, el estado vacío del Terminal (y su menú **+**, y
    Ajustes → **Terminal**) ofrece **Descargar mongosh**. Baja la última versión
    estable oficial para tu sistema desde la web de descargas de MongoDB
    (Windows, macOS y Linux, x64 y — salvo Windows — ARM), la comprueba contra
    la suma de comprobación que publica MongoDB y la descomprime en la carpeta
    de datos propia de HuginnDB; no se instala nada en el sistema ni hacen
    falta permisos de administrador. Muestra el progreso y se puede cancelar.
    Un `mongosh` que hayas instalado tú siempre tiene prioridad sobre el
    descargado, y cuando se usa la copia de HuginnDB, Ajustes ofrece
    **Actualizar a X** si MongoDB ha publicado una versión más nueva.
  - **Con una política gestionada, está desactivado salvo que el rol lo
    permita.** Un rol con `"allowToolDownloads": true` puede descargar
    `mongosh`; sin él, el botón no aparece (el Terminal explica por qué) y
    HuginnDB rechaza la petición. Véase `docs/POLICY.es.md`.
  - Con el foco en el terminal, teclas de shell como `Ctrl+R` o `Ctrl+B`
    llegan al shell en vez de a la app. Copiar y pegar son
    `Ctrl+Shift+C` / `Ctrl+Shift+V`.
  - Con una política gestionada, `mongosh` solo está disponible en conexiones
    donde puedes lanzar consultas libres que lean y escriban cualquier cosa.
    El shell normal no se ve afectado.
- **Pulse y el panel de IA se pueden ocultar.**
  - Ajustes → Pulse tiene un nuevo interruptor **Activar Pulse**, encendido
    por defecto. Apagado, quita Pulse de la barra de actividad, el menú Ver,
    la paleta de comandos y su atajo, y detiene el muestreo en segundo plano.
    Las conexiones que habías activado se conservan para cuando lo vuelvas a
    encender.
  - El interruptor que ya tenía el panel de IA ahora también oculta su icono
    mientras está apagado.
  - El terminal tiene el mismo interruptor, en Ajustes → Terminal; apagado,
    además cierra todas las sesiones abiertas.

### Cambiado

- **Las pantallas vacías se leen mejor.** Los puntos de trama cubrían todo el
  panel y pasaban por debajo del título y de la pista; en un panel bajo y
  ancho como el Terminal se estiraban en una franja plana de puntos. Ahora
  son un halo redondo y más tenue solo detrás del logo, igual en todos los
  paneles y en la pantalla de inicio. El motivo por el que algo no se puede
  hacer (no se encuentra `mongosh`, una política que no lo permite)
  aparece ahora en su propio recuadro bajo el mensaje en vez de sustituir a
  la pista.
- **El panel de Esquema responde igual tenga la base de datos las tablas que
  tenga.** Al abrir una sección con 10.000 tablas se montaban las 10.000
  filas a la vez, cada una con su menú contextual, y el panel se quedaba
  congelado. El árbol es ahora una única lista virtualizada, de las carpetas
  a las columnas, y solo existen las filas cercanas a la zona visible. Se ve
  y se comporta como antes:
  - mismas guías, menús y filtro;
  - las flechas siguen moviendo entre filas de conexión, desplazándose hasta
    una que esté lejos;
  - una base de datos desplegada muy abajo en la lista sigue abriendo su pool
    al arrancar, así que sus pestañas guardadas vuelven.
- **Una base de datos con miles de tablas muestra su lista de tablas al
  momento.** El número de filas y el tamaño llegan ahora un instante después
  de los nombres en todos los drivers, no solo en MongoDB. Leerlos es la parte
  que crece con el número de tablas: las estadísticas de particiones de SQL
  Server, un `stat` de cada fichero en PostgreSQL, `SHOW TABLE STATUS` en
  MySQL (que en 5.7 abre cada tabla) y una consulta a `dbstat` *por tabla* en
  SQLite, ahora un único agregado. En una base de SQL Server con más de
  10.000 tablas, todo eso se ejecutaba antes de que el árbol pudiera mostrar
  nada, y contaba para el tiempo de espera de la operación. Cada listado usa
  ahora la lectura de catálogo más barata de su motor (`sys.objects`,
  `information_schema.tables`, `SHOW FULL TABLES`, `sqlite_master`). El
  `list_tables` del conector MCP, la estimación de progreso del volcado y el
  panel de IA siguen recibiendo las cifras junto a los nombres, de las mismas
  dos lecturas.
- **El botón de la consola de la barra de estado cambia a la Consola cuando
  se está mostrando el Terminal**, en vez de cerrar el panel.
- **Los "hard-earned gotchas" internos se archivan ahora como ADRs, gotchas y
  convenciones** bajo `engineering/` (antes `adr/`). Leídas una a una, 85 de
  las 107 entradas eran decisiones con alternativas, 9 eran normas de la casa
  y 13 eran gotchas en sentido estricto: hechos de una dependencia que ningún
  diseño nuestro puede cambiar. Cada tipo se retira de forma distinta. Una
  decisión se sustituye por un ADR nuevo, un gotcha queda obsoleto cuando la
  dependencia lo corrige y una convención se edita en su sitio. Cada entrada
  lleva ahora front matter (tipo, estado, fecha original recuperada del
  historial de `CLAUDE.md`, etiquetas, related / supersedes / amends), y los
  ADRs empiezan por su decisión y las alternativas que el cuerpo recoge como
  descartadas. La numeración sigue siendo una única secuencia global, así que
  toda cita `#N` existente sigue resolviendo. Los comentarios del código y la
  documentación nombran ahora el tipo (`ADR #54`, `gotcha #19`,
  `convention #28`). `node scripts/engineering-index.mjs` regenera los cuatro
  índices desde el front matter (`--check` avisa si alguno está desfasado).
  Solo documentación: ningún cambio de comportamiento.
- **Los ADR #24 y #81 ya no describen superficies que han desaparecido.**
  Cada uno gana un apéndice fechado. Desde la 1.23.0, el aviso del sidecar
  del #24 pasa por `confirmIrreversible` y el `ConfirmHost` de la app, no por
  `window.confirm`. En la 1.28.0, las condiciones de filtro del #81 pasaron
  del diálogo de filtro avanzado (eliminado) al panel de consulta y al
  diálogo de actualización masiva, y el bloque contenedor del panel de
  sugerencias fijo es ahora el viewport. Ninguna de las dos decisiones
  cambia.

### Corregido

- **Conectar a través de un servidor SSH que no respondía podía quedarse
  colgado para siempre.**
  - Si el servidor SSH aceptaba la conexión y luego no respondía nunca (un
    servidor sobrecargado, o un cortafuegos que retiene las conexiones en
    vez de rechazarlas), HuginnDB se quedaba esperando indefinidamente en
    «Conectando…».
  - Si pasaba mientras un túnel se reconectaba solo, todas las consultas de
    esa conexión esperaban detrás, y después cada una volvía a iniciar sesión
    en el servidor.
  - Ahora abrir la sesión SSH se da por perdido a los 15 segundos y se indica
    qué servidor SSH no respondió.
- **Un túnel SSH podía dejar más de una sesión abierta en el servidor.**
  - Cuando un servidor tardaba en abrir una conexión a través del túnel,
    HuginnDB daba la sesión SSH por muerta y volvía a iniciar sesión, aunque la
    sesión seguía funcionando. Tampoco cerraba la antigua: seguía abierta en el
    servidor mientras alguna conexión a la base de datos la usara, hasta media
    hora.
  - En servidores que solo permiten unas pocas sesiones SSH a la vez, esas
    sesiones sobrantes podían agotar el cupo.
  - Ahora una conexión lenta se informa como lenta, y HuginnDB solo vuelve a
    iniciar sesión cuando la sesión de verdad ha caído. Cuando lo hace, cierra
    primero la antigua.
- **Un túnel SSH caído volvía a iniciar sesión en el servidor una y otra vez.**
  - Cuando la sesión de un túnel se caía y volver a iniciarla fallaba, cada
    conexión que lo usaba lo intentaba de nuevo por su cuenta: la comprobación
    de conexión, Pulse, MongoDB, cada consulta. Un servidor que bloquea
    direcciones tras inicios de sesión SSH repetidos recibía un goteo constante,
    así que el bloqueo podía durar tanto como HuginnDB siguiera abierto.
  - Tras un intento fallido, el túnel ahora espera antes de volver a intentarlo:
    5 segundos al principio, duplicando hasta 5 minutos. Mientras tanto las
    consultas fallan al momento e indican cuándo será el siguiente intento.
    Reconectar a mano sigue intentándolo en el acto.
- **El conector MCP podía abrir la misma conexión varias veces a la vez.**
  - Cuando la IA lanzaba varias herramientas juntas y el conector trabajaba
    sin la app de HuginnDB abierta, cada herramienta abría su propia conexión
    al servidor. A través de un túnel SSH eso eran varios inicios de sesión
    SSH contra el mismo servidor en menos de un segundo, algo que los
    servidores que limitan las conexiones SSH nuevas por minuto pueden tratar
    como un ataque y bloquear.
  - Ahora las herramientas esperan a que la primera abra la conexión y la
    comparten, como ya hace la propia app desde la 1.32.0.

## [1.33.0] — 2026-10-14

### Corregido

- **El conector MCP dejaba de funcionar en Linux cada vez que se cerraba un
  AppImage.**
  - Un AppImage se ejecuta desde una carpeta temporal (`/tmp/.mount_Huginn…`)
    que cambia de nombre en cada arranque y desaparece al cerrar la app.
    Ajustes → MCP, y el botón **Añadir a Claude Code**, registraban el
    conector en esa ruta temporal, así que el cliente de IA lo perdía en
    cuanto HuginnDB se cerraba o se reiniciaba.
  - Desde un AppImage, los clientes apuntan ahora al propio archivo
    `.AppImage` con `--mcp` (`HuginnDB.AppImage --mcp`), que arranca el
    conector dentro de la imagen. Esa ruta sobrevive a reinicios y
    actualizaciones. El resto de tipos de instalación no cambian.
  - Si ya lo habías registrado, Ajustes → MCP te avisa de que Claude Code
    apunta a una ruta que ya no existe, y **Actualizar registro** la
    sustituye, conservando los argumentos que hubieras añadido
    (`--connections`, `--read-only`). Antes, **Añadir a Claude Code** solo
    respondía que ya estaba registrado.
- **El conector MCP seguía usando los datos antiguos de una conexión después
  de editarla.**
  - Apuntar una conexión guardada a otra base de datos (u otro host, u otro
    usuario) en HuginnDB no le llegaba a un conector que ya estaba en marcha.
    Seguía consultando la base de datos anterior hasta reiniciar el cliente de
    IA, incluso tras un rato de inactividad, porque reabría con los datos que
    había leído al arrancar.
  - El conector lee ahora los datos actuales de la conexión en cada llamada, y
    reabre una conexión que se haya editado desde que la abrió.
  - Con el *bridge* activado, una conexión que el conector abrió a través de
    la app se reabre igual. Si la conexión está abierta en una ventana de
    HuginnDB, el conector te pide que la reconectes allí en vez de cerrarla
    por debajo de tus pestañas.
- **Editar una conexión abierta no surtía efecto hasta reconectarla, y nada
  lo indicaba.**
  - Apuntar una conexión abierta a otra base de datos (u otro host, usuario,
    ajuste SSL o túnel SSH) dejaba el árbol, las pestañas y cada consulta en
    la anterior.
  - Esa conexión se marca ahora en ámbar en la lista de conexiones y en la
    barra de estado, en todas las ventanas, con **Reconectar** en un clic. No
    se cierra por ti, así que no se pierde una consulta en marcha ni las
    ediciones del grid sin guardar.
  - **Conectar** en el diálogo de conexión, después de editarla, ahora
    reconecta. Antes reutilizaba la sesión abierta con los datos anteriores.

## [1.32.0] — 2026-10-08

### Añadido

- **El visor de documentación se rehace para encajar con Ajustes.**
  - Ahora es tan grande como Ajustes y tiene el mismo diseño: un rail a la
    izquierda con su propio buscador, las guías agrupadas en *Primeros pasos*,
    *Bases de datos*, *Integraciones* y *Organización*, y una cabecera en cada
    página.
  - Se abre en una **página de inicio** con una tarjeta por guía que dice para
    qué sirve, en vez de dejarte dentro de la primera guía.
  - **Busca en el texto de todas las guías** desde el rail (`Ctrl+F` con el
    visor abierto). Cada resultado muestra el pasaje con tus palabras marcadas
    y abre la página y el encabezado donde está.
  - Una columna **En esta página** sigue tu desplazamiento y salta a un
    encabezado; en ventanas más estrechas esos encabezados se quedan en el
    rail. Los botones **Anterior / Siguiente** al pie de cada página siguen la
    lectura, y pasan a la guía siguiente cuando una termina.
  - Una guía que también es una sección de Ajustes tiene un botón **Abrir
    ajustes**, y hay un botón **Ver en GitHub** con el código fuente de la guía.
- **Cada sección de Ajustes que tiene guía ahora tiene un botón "Leer la
  guía"** en su cabecera: Conexiones, Atajos, Esquemas JSON, Orígenes
  compartidos, MCP, Pulse, IA y Política gestionada. Conexiones y Orígenes
  compartidos abren la guía en la parte que explica esa sección. Los dos
  enlaces de texto que MCP y Pulse tenían al pie de su página quedan
  sustituidos por él.

- **Ajustes → Conexiones muestra cuántas conexiones hay abiertas de verdad.**
  - Cada servidor indica ahora, por ejemplo, `2 abiertas · 7 de 10 reservadas`.
    Antes solo aparecía el número de reservadas, y ese no es el que ve el
    servidor.
  - *Reservadas* es hasta dónde pueden crecer las conexiones de HuginnDB a ese
    servidor; *abiertas* es lo que el servidor cuenta en este momento, y suele
    ser mucho menos.
  - Un botón **?** nuevo junto a los números abre la sección de la
    documentación que explica ambos.

### Cambiado

- **Caben más conexiones al mismo servidor dentro de su límite.**
  - Antes cada conexión reservaba 5 de los 10 de un servidor. Con dos perfiles
    apuntando al mismo servidor, un tercero se rechazaba aunque el servidor
    solo tuviera dos o tres conexiones abiertas.
  - La primera conexión a un servidor sigue reservando 5. Cada una de las
    siguientes reserva ahora la mitad de lo que quede, y nunca menos de 2. Así
    caben tres conexiones en vez de dos.
  - Cuando se alcanza el límite, HuginnDB cierra primero las vistas de base de
    datos de ese servidor que no has usado últimamente, y solo rechaza la
    conexión si con eso no basta.

### Corregido

- **Desconectar se notaba lento y podía decir que no se había podido leer el
  esquema.**
  - La ventana esperaba a que la conexión terminara de cerrarse antes de
    mostrarla como desconectada. Detrás de un túnel SSH esa espera dura unos
    segundos.
  - Durante esos segundos, cualquier lectura del esquema que siguiera en curso
    fallaba y mostraba un error, aunque hubieras pedido desconectar.
  - Ahora el árbol, las pestañas de la conexión y el resto de ventanas se
    actualizan a la vez y al momento, y la conexión termina de cerrarse en
    segundo plano.
- **Una base de datos desplegada podía volver a abrirse sola tras desconectar.**
  Una petición que llegaba justo después de desconectar podía volver a abrir la
  conexión de esa base de datos (con su propio túnel SSH), y nada la cerraba
  nunca. Ahora una base de datos solo se reabre mientras su conexión sigue
  abierta.
- **El límite de conexiones que mostraban los Ajustes ignoraba el límite propio
  de una conexión.** Un servidor con su propio máximo fijado en la conexión se
  mostraba contra el máximo global. Ahora cada servidor muestra el límite que
  de verdad se le aplica.

- **El conector MCP dejaba de funcionar al cerrar HuginnDB.** Con el puente
  (bridge) activo, el conector debe usar sus propias conexiones cuando la app
  no está para prestárselas. No lo hacía: todas las llamadas fallaban hasta
  reiniciar la sesión de la IA. Ahora vuelve a sus propias conexiones como
  estaba previsto.
- **La primera petición de la IA tras reiniciar HuginnDB fallaba.** Un
  conector enganchado a la app seguía usando el enlace antiguo, ya cerrado, y
  solo se daba cuenta cuando esa petición había fallado. Ahora lo comprueba
  antes y se reconecta antes de enviar.
- **Un conector arrancado con HuginnDB cerrado nunca usaba las conexiones de la
  app.** Solo buscaba la app una vez, al arrancar. Las sesiones de IA suelen
  quedarse abiertas días, así que la mayoría de los conectores acababan
  abriendo sus propias conexiones para siempre. Ahora el conector sigue
  buscando la app (como mucho cada 30 segundos) y pasa a usar sus conexiones
  cuando la encuentra.
- **Pulse mantenía abiertas para siempre las conexiones del conector MCP.** En
  una conexión con Pulse activado, la muestra que toma cada minuto contaba
  como actividad, así que una conexión abierta para el conector MCP nunca se
  cerraba por inactividad. Las muestras ya no cuentan como actividad.

- **Las conexiones a través de un túnel SSH se caían pasado un rato y no
  volvían solas.**
  - El túnel no enviaba ningún keepalive propio, así que un firewall o un router
    que cierra las conexiones inactivas podía cortarlo sin avisar.
  - Una vez caído, todas las consultas que pasaban por él fallaban hasta
    reconectar a mano.
  - Ahora los túneles envían su propio keepalive cada 30 segundos, y un túnel
    cuya sesión se ha caído se reconecta solo la siguiente vez que se usa.
- **Una conexión perdida había que reconectarla a mano aunque ya hubiera
  vuelto.**
  - HuginnDB reintenta ahora dos veces antes de dar una conexión por perdida,
    así que un corte momentáneo (una VPN que se reconecta, un portátil que sale
    de suspensión) ya no lanza una alerta.
  - Además, sigue comprobando una conexión perdida. Cuando vuelve a responder,
    desaparecen el aviso y su botón **Reconectar**, y se te informa de que la
    conexión se ha recuperado.
- **Una consulta tras una pausa larga podía esperar 30 segundos y luego decir
  que el servidor tenía demasiadas conexiones.**
  - Cada conexión se comprueba antes de usarla. Si esa comprobación no recibía
    respuesta (una conexión que la red había cortado en silencio), nunca se
    abandonaba: la consulta esperaba los 30 segundos completos y el tiempo de
    espera se presentaba como un servidor lleno.
  - Ahora la comprobación se rinde a los 5 segundos y la consulta recibe sin
    más una conexión nueva. Las conexiones a SQL Server, que no se comprobaban
    en absoluto, pasan ahora por la misma comprobación.
- **Desplegar una base de datos en una conexión con túnel SSH era lento.**
  - Cada base de datos que desplegabas abría una sesión SSH completa nueva con
    el bastión antes de su primera consulta.
  - Ahora reutiliza el túnel que ya tiene su conexión, lo que hace que abrir una
    base de datos sea más del doble de rápido en un túnel típico (de unos 0,8 s
    a unos 0,3 s).

- **Cerrar una ventana dejaba abiertas sus conexiones.** Una conexión abierta
  en una ventana secundaria seguía abierta en el servidor después de cerrar esa
  ventana, hasta que se cerraba el propio HuginnDB. Ninguna otra ventana la
  mostraba, así que no había forma de cerrarla. Ahora una conexión se cierra
  cuando lo hace la última ventana que la usa, y una pestaña flotante o una
  ventana de Pulse cuentan como ventanas que usan la conexión que muestran.
- **Al salir de HuginnDB sus conexiones no se cerraban como es debido.** Las
  conexiones abiertas simplemente se descartaban al salir de la app. Un
  servidor detrás de un túnel SSH o de un pooler de conexiones podía seguir
  contando esas sesiones contra su límite de conexiones hasta que saltaban sus
  propios tiempos de espera. Ahora HuginnDB las cierra correctamente al salir,
  esperando como mucho tres segundos.
- **La misma conexión podía abrirse dos veces a la vez.** Si dos peticiones
  para la misma conexión o base de datos llegaban a la vez, cada una podía
  abrir su propio pool y ocupar durante un momento el doble de conexiones en
  el servidor. Podía pasar con una ventana y el conector MCP, o con el árbol
  desplegando una base de datos mientras se ejecutaba una acción del menú
  sobre ella. Ahora la segunda petición espera a la primera y reutiliza su
  pool.

- **Una base de datos desplegada se quedaba en blanco mientras cargaba.** El
  árbol de esquemas muestra ahora filas provisionales hasta que llegan las
  tablas de la base de datos, y un indicador de carga en la propia fila de la
  base de datos mientras se abre o se refresca. Así se distingue un servidor
  lento de una base de datos vacía, incluso con el nodo plegado.
- **Una base de datos que no se podía abrir lo reintentaba sin fin.** Al
  desplegar una base de datos que el servidor rechazaba (por ejemplo, por
  quedarse sin conexiones), se volvía a intentar al instante, para siempre, con
  una notificación de error nueva cada vez. Ahora se detiene en el primer fallo
  y muestra el error con un botón **Reintentar**. Plegar y volver a desplegar
  el nodo también lo reintenta.
- **Un fallo al leer el esquema solo tenía arreglo desde un menú contextual.**
  La línea de error del árbol lleva ahora un botón **Reintentar**.
- **Al conectar se pedía el esquema dos veces.** Con la fila de la conexión ya
  desplegada, las listas de bases de datos y de tablas se leían dos veces en
  cada conexión. Ahora las peticiones que ya están en curso se comparten, y lo
  mismo pasa al volver a abrir una tabla antes de que lleguen sus columnas.
- **Cada base de datos que desplegabas volvía a leer la lista entera de bases
  de datos del servidor.** Ahora reutiliza la lista que ya tiene su conexión.

- **Desplegar una base de datos MongoDB era lento a través de un túnel SSH.**
  El árbol esperaba a tener el número de documentos de todas las colecciones
  antes de mostrar ninguna, y además los pedía uno detrás de otro. Detrás de un
  túnel, una base de datos con noventa y tantas colecciones tardaba más de dos
  segundos en aparecer. Ahora las colecciones aparecen al momento (unos 25 ms
  por el mismo túnel), y sus recuentos y tamaños se rellenan un instante
  después, leídos varios a la vez.
- **Las colecciones de MongoDB nunca mostraban su tamaño en el árbol.** La
  lectura que debía traer los tamaños no podía funcionar contra una base de
  datos entera, y su fallo se ignoraba en silencio. Ahora los tamaños salen de
  la misma lectura por colección que el número de documentos, sin coste
  añadido. Las colecciones fragmentadas (sharded) muestran el total de todos
  sus shards.

## [1.31.1] — 2026-10-05

### Corregido

- **Los controles de ventana de una pestaña flotante o de Pulse salían a la
  izquierda.** Los botones de minimizar, maximizar y cerrar se dibujaban pegados
  al logo en vez de en el borde derecho, porque el único contenido de la barra
  de título de esas ventanas es el título centrado, que no ocupa sitio en la
  fila. Ahora la barra de título rellena la fila por sí misma y los botones
  quedan a la derecha en todas las ventanas.
- **El panel de consulta nunca se abría en una pestaña flotante.** Su botón se
  quedaba cargando para siempre: la ventana no conecta (reutiliza el pool que ya
  tiene abierto la principal), así que nadie abría la caché de esquema de su
  conexión y cada lectura de columnas que hacía se descartaba por obsoleta.
  Ahora la ventana abre esa caché antes de montar la pestaña.

## [1.31.0] — 2026-10-01

### Añadido

- **Abrir un entorno en una ventana nueva (#219).** Haz clic derecho en un
  entorno del rail y elige *Abrir entorno en una ventana nueva* para trabajar en
  él junto al actual, en vez de salirte de una disposición que acabas de
  preparar. La ventana nueva muestra las conexiones y los filtros de base de
  datos de ese entorno y reconecta las conexiones que tenía abiertas,
  reutilizando un pool que la ventana principal ya tenga. Sigue siendo efímera
  como cualquier ventana secundaria: no se trasladan pestañas ni disposición, no
  se escribe nada, y el entorno de la ventana principal y lo que reabre al
  arrancar quedan intactos.

### Corregido

- **Eliminar una fila que otras tablas siguen referenciando ahora lo dice en el
  propio diálogo que la pidió (#218).** El rechazo caía en la franja sobre la
  cuadrícula, oculto tras el velo de la confirmación, así que el clic parecía no
  hacer nada. Ahora el diálogo sigue abierto con el motivo y —cuando la causa es
  una clave foránea— nombra las tablas que aún apuntan a la fila, y el botón
  vuelve a poder usarse. Con «confirmar acciones destructivas» desactivado, el
  fallo sale como aviso en vez de en esa franja, que queda solo para errores de
  carga.
- **Un script de MongoDB con una llamada por línea ahora ejecuta todas (#220).**
  En `mongosh` el `;` es opcional, pero la pestaña de consulta solo dividía por
  él, así que tres `countDocuments` en tres líneas eran una sola sentencia: la
  pestaña ejecutaba la primera, el parser descartaba las otras dos sin avisar y
  salía un único resultado en vez de tres. Ahora un salto de línea termina la
  sentencia cuando no queda nada abierto — un `.sort(…)` en la línea siguiente
  o un `{ … }` de varias líneas siguen perteneciendo a la sentencia de arriba —,
  de modo que cada llamada tiene su propia pestaña de resultado y su propio ▶
  Run. El backend además dejó de descartar texto sobrante: una sentencia seguida
  de otra se rechaza ahora con un error (`run_query` por MCP, panel de IA), en
  vez de ejecutar la primera y dar por bueno el resultado.

## [1.30.0] — 2026-09-28

### Añadido

- **HuginnDB se mantiene al día solo, aunque nadie lo abra.** Pensado para
  quien solo usa el conector MCP desde su herramienta de IA y nunca abre la
  app, que hasta ahora no recibía ninguna actualización. En Windows, una tarea
  programada comprueba al iniciar sesión y otra una vez al día, e instala las
  versiones nuevas sin avisar, con el mismo feed firmado que usa el
  actualizador de la app; y como la extensión de Claude Desktop cede sus
  sesiones al conector instalado, el conector se actualiza con ella. Nunca
  instala mientras HuginnDB está abierto, y la comprobación diaria también
  espera mientras una herramienta de IA tiene el conector en marcha; la de
  inicio de sesión instala igualmente, así que un equipo cuya herramienta de IA
  no se cierra nunca también se actualiza. Viene activado, no necesita política
  gestionada y se puede desactivar en Ajustes → Acerca de → Actualizaciones en
  segundo plano, que además muestra qué mecanismo está funcionando: si el
  administrador del dominio prohíbe las tareas programadas, recurre a una
  entrada de inicio, y si también la prohíbe, lo dice en vez de disimularlo.
  Si una actualización sigue esperando al cabo de un día, el conector MCP se
  lo dice a la herramienta de IA, que lo transmite; el conector lo lee de lo
  que registró la app y nunca consulta el feed de actualizaciones por su
  cuenta. Desinstalar HuginnDB elimina las tareas.
- **Conexiones recientes en la barra de tareas de Windows.** Al hacer clic
  derecho en el botón de HuginnDB de la barra de tareas (o en su entrada del
  menú Inicio) aparecen las últimas conexiones que usaste, y al elegir una se
  abre: con la app en marcha pregunta, como cualquier lanzamiento desde la
  línea de comandos, si abrirla en la ventana actual o en una nueva; con la app
  cerrada, la arranca y conecta. La tarea **Nueva ventana** abre otra ventana.
  Recientes significa primero las conexiones abiertas desde el arranque y
  después el resto según cuándo se tocaron sus pestañas por última vez; quedan
  fuera las conexiones *ad hoc* de la línea de comandos, que nunca se guardan,
  y las que abre una IA a través del conector MCP. Windows guarda la lista en tu
  perfil de usuario, así que solo se escribe el nombre de la conexión y su
  motor —nunca el host, la base de datos ni la contraseña—, y Ajustes → General
  → Conexiones recientes en la barra de tareas desactiva la categoría (Nueva
  ventana se queda).

### Cambiado

- **Una sola barra de título en vez de dos.** En Windows y Linux desaparece la
  barra de título nativa, y la barra propia de HuginnDB —los menús, la ruta de
  la conexión, la campana de notificaciones y los botones de los paneles— lleva
  ahora también los botones de minimizar, maximizar y cerrar, como hacen Claude
  Desktop y VS Code. Así se recuperan los 32 px que ocupaba la barra nativa en
  cada ventana, también en las pestañas flotantes y en Pulse, cuya barra muestra
  el título de la ventana. La ventana se sigue arrastrando desde cualquier hueco
  de la barra, un doble clic la maximiza y el ajuste de Windows (Win+Z,
  Win+flechas, arrastrar a un borde de la pantalla) funciona como antes; lo
  único que falta es el selector de diseños que Windows 11 muestra al dejar el
  puntero sobre maximizar, que Windows solo ofrece en un botón dibujado por él
  mismo. Las cintas de canary, de política y de color de ventana pasan a ir
  debajo de la barra en vez de encima, para que el botón de cerrar siga en la
  esquina de la ventana. macOS conserva su marco nativo.

### Corregido

- **El aviso de «Abrir conexión entrante» nombraba la conexión por su id.** Un
  lanzamiento con `--connect-profile-id` —el que usa cada entrada de la barra de
  tareas— preguntaba si abrir «62a5d650-23a7-…» en vez del nombre de la
  conexión. Ahora muestra el nombre, y solo recurre al id cuando ninguna
  conexión lo tiene.

- **La extensión de Claude Desktop se actualiza ahora con la app.** El `.mcpb`
  llevaba su propia copia del conector, y Claude Desktop seguía ejecutando esa
  copia fuera cual fuera la versión de HuginnDB instalada al lado: las
  herramientas nuevas no llegaban nunca al asistente, y una extensión anterior
  a la 1.29 no aplicaba la política gestionada que la propia app sí aplicaba.
  En Windows, la extensión cede ahora cada sesión al conector instalado con la
  app, así que se instala una vez y cada actualización de HuginnDB es también
  una actualización del conector. Sin la app instalada, sirve la sesión ella
  misma, como antes; `HUGINNDB_MCP_PATH` la apunta a otro sitio o, definida
  pero vacía, desactiva el traspaso. Instalar esta versión de la extensión es
  la última vez que hay que hacerlo a mano.

- **El fichero de estado de ventanas ya no crece con cada ventana que abres.**
  HuginnDB recordaba la posición y el tamaño de todas las ventanas que había
  mostrado alguna vez, pero las pestañas flotantes, las ventanas de Pulse y
  **Nueva ventana** reciben un nombre interno nuevo cada vez, así que ninguna
  de esas entradas se podía volver a usar y ninguna se borraba nunca. Ahora
  solo se recuerda la ventana principal, y los restos se eliminan de
  `.window-state.json` en el primer arranque de esta versión. La ventana
  principal conserva su posición y tamaño guardados; las secundarias se abren
  donde siempre.

## [1.29.0] — 2026-09-28

### Añadido

- **Ctrl+F busca en lo que tengas delante.** Con una pestaña de tabla activa
  pone el cursor en el filtro de esa tabla, seleccionando lo que haya para que
  escribas encima; sin pestaña de tabla activa va al filtro del árbol de
  esquemas, abriendo el panel si está plegado; con Preferencias abierto va al
  buscador de ajustes. Dentro de un editor de consultas o de JSON no hace nada
  propio, así que la búsqueda del editor sigue funcionando como siempre, y
  dentro de cualquier otro diálogo deja la tecla tranquila en vez de apuntar a
  un cuadro que el diálogo tapa. Ctrl+Mayús+F sigue llevando al árbol desde
  cualquier sitio, y los dos se pueden reasignar en Preferencias → Atajos.

- **Política gestionada: un administrador decide, una sola vez, a qué puede
  acceder la IA en todas las instalaciones.** Pensada para organizaciones que
  despliegan HuginnDB en muchos puestos, donde configurar cada uno a mano era
  la objeción. Una política —en `HKLM\SOFTWARE\Policies\HuginnDB` o como
  `managed-policy.json` en la carpeta de políticas del sistema, con el
  contenido o apuntando a un fichero en una carpeta compartida— da a cada
  cuenta del sistema un rol, y cada rol tiene reglas por servidor: qué bases de
  datos y relaciones se ven, y si la IA puede consultar, insertar, actualizar,
  borrar o cambiar el esquema, cada cosa por separado, además de `monitor` para
  Pulse, sesiones y usuarios. Esta versión la aplica **a la IA**, donde se
  cumple de verdad y no es orientativa: el modelo nunca tiene credenciales, y
  todas las peticiones del conector MCP (con la app abierta o sin ella) y del
  agente y las tareas asistidas del panel de IA pasan por la única función
  donde se comprueba la política. El descubrimiento se filtra, así que la IA no
  llega a saber los nombres de lo que no puede alcanzar; las consultas libres
  se retiran allí donde una regla limita qué relaciones se ven, porque el texto
  de una consulta no se puede comprobar contra eso; y la IA nunca tiene más que
  los permisos `human` de su usuario. Solo restringe los ajustes MCP y de IA
  por conexión, nunca los amplía. Una política ilegible o inválida bloquea
  todas las peticiones de la IA en vez de quedarse sin política, una errata en
  el fichero es un error y no una restricción que falta, y la cuenta se lee del
  sistema operativo, nunca de `USERNAME`. **Ajustes → Política** muestra de
  dónde viene la política, la cuenta y el rol, y qué permite cada conexión
  —empezando por las conexiones que nombra alguna regla, una línea por
  conexión hasta desplegarla, con filtro por nombre para equipos con decenas
  de ellas—; el
  registro de auditoría MCP anota ahora `user=` y `role=`. Aplicar los permisos
  `human` a las personas en la app es la siguiente fase. Ver
  [`docs/POLICY.es.md`](docs/POLICY.es.md) y el gotcha #94 de `CLAUDE.md`.

- **La política gestionada ahora se aplica también a las personas, como
  guardarraíl.** Los permisos `human` de un rol se leían, se mostraban y
  limitaban a la IA, pero los comandos de la propia app no los aplicaban. Ahora
  todos los comandos que tocan una base de datos los comprueban antes —unos
  sesenta, cada uno diciendo lo que hace—: los listados se filtran para que
  nunca se nombre una base de datos o relación oculta (tampoco las claves
  ajenas que llegan desde una tabla oculta); lecturas, inserciones,
  actualizaciones, borrados y DDL se rechazan por relación y por verbo; `export`
  protege todas las formas de sacar filas a un fichero, y `monitor` protege
  Pulse, las sesiones y el panel de Seguridad. El SQL libre se rechaza en una
  regla que limita relaciones, y también todo lo que es SQL libre sin
  parecerlo: la expresión `WHERE` escrita a mano del panel de consulta (una
  subconsulta lee cualquier tabla), el cuerpo de una vista, un pipeline de
  MongoDB que une otras colecciones con `$lookup` / `$unionWith` /
  `$graphLookup`, el selector de claves ajenas leyendo su tabla destino, un
  renombrado que mueve una colección a otra base de datos. Con una política
  rota o ilegible, una persona puede abrir la app y sus ajustes, pero no leer
  ni escribir en ninguna conexión. Es un guardarraíl y lo dice: quien tiene la
  contraseña de la base de datos puede usar otro cliente, y eso lo cierran los
  usuarios de base de datos por persona (la siguiente fase). Un test falla si
  se registra un comando nuevo sin decir qué le pide la política, y otro si un
  comando que toca una base de datos nunca llama a la comprobación. Ver el
  gotcha #95 de `CLAUDE.md`.
- **Lo que la política gestionada no permite aparece bloqueado en la
  interfaz, con el motivo.** Los comandos ya lo rechazaban; ahora los controles
  lo dicen antes de usarse. Un elemento de menú que el rol de la persona no
  permite sigue en su sitio, deshabilitado, con un candado y una línea bajo su
  nombre que dice qué no permite la política: borrar y renombrar, nueva tabla
  y vista, importar, exportar, Seguridad, crear y borrar base de datos,
  conectar. Una pestaña cuyo propósito entero se rechaza muestra un estado
  vacío bloqueado en vez de fallar en cada petición: el editor de consultas
  sin SQL libre (también las pestañas de consulta restauradas de la sesión
  anterior), Seguridad y Pulse sin `monitor`, y cualquier pestaña mientras la
  política carga o está rota. En el grid, editar, insertar, duplicar, borrar
  y la edición masiva siguen cada uno su verbo, y una línea sobre las filas
  dice qué falta; exportar sigue a `export`; en SQL, la expresión escrita a
  mano del panel de consulta se bloquea en una regla que limita relaciones, y
  una ya aplicada sigue visible, y se puede quitar, sin enviarse. Los editores
  de estructura, vistas, agregaciones e índices bloquean Aplicar, Guardar y
  Crear; la vista previa en vivo de una vista dice por qué en vez de ejecutar
  su cuerpo. Una barra en la ventana avisa cuando la política está cargando o
  no se pudo aplicar, con un enlace a Ajustes → Política, cuyo texto ahora
  habla de las personas además de la IA. En una máquina sin política no
  cambia nada: allí basta una llamada para saberlo y nunca se pregunta por
  ninguna relación. Ver el gotcha #96 de `CLAUDE.md`.

- **Cada persona puede conectarse con su propio usuario de base de datos.**
  Para las personas, la política gestionada es un guardarraíl mientras una
  contraseña compartida de la base de datos pueda abrir cualquier otro cliente;
  un usuario de base de datos por persona, con los permisos que correspondan, es
  lo que permite que la aplique la propia base de datos. El nuevo `dbUser` de
  una regla fija el usuario con el que una persona entra en ese servidor —una
  plantilla con un único token, `{user}`, que es su cuenta del sistema sin el
  dominio (`"{user}"`, `"erp_{user}"`)— y el diálogo de la conexión lo muestra
  bloqueado. Sin él, una persona puede elegir su propio usuario en una conexión
  de un origen compartido («Tus credenciales»), guardado solo en ese equipo:
  nunca se publica, se exporta ni se sincroniza. Mientras hay un usuario
  personal, la contraseña compartida del origen deja de guardarse en el equipo,
  que es lo que impide que abra otro cliente desde allí. Una conexión que no
  encuentra contraseña para el usuario con el que entra ahora la pide, y puede
  recordarla, en vez de informar de un llavero vacío; vale para cualquier
  conexión, no solo estas. En MongoDB, el usuario y la contraseña publicados se
  quitan de la cadena de conexión. Ajustes → Política muestra el usuario fijado.
  Las versiones anteriores a esta dan por no válida una política con `dbUser` y
  bloquean, así que actualiza antes todas las instalaciones. Ver el gotcha #97 de
  `CLAUDE.md`.

- **HuginnDB escribe los permisos de base de datos que necesita un rol de la
  política.** Un usuario de base de datos por persona solo aplica la política
  si sus permisos coinciden con el rol, y escribirlos a mano para cada rol y
  servidor es donde se desincronizaría. Ajustes → Política → **Generar
  permisos** elige un rol y un servidor al que el administrador está
  conectado, lee su catálogo y escribe el script: un rol de base de datos
  `huginn_<rol>` con sus `GRANT` en PostgreSQL, MySQL y SQL Server, y un
  `createRole` con acciones por colección en MongoDB. Una regla sobre todas las
  relaciones de una base de datos concede a nivel de base de datos o de esquema
  (cubre las tablas que se creen después); una que nombra relaciones o tiene un
  `deny` se expande a las tablas que existen ahora, porque un `GRANT` no admite
  comodines, y el script dice que hay que regenerarlo. Las reglas se suman
  sobre el mismo objeto; `ddl` y `monitor` se traducen a los permisos propios
  de cada motor; las personas a las que la política da el rol aparecen
  comentadas, tal como entran. Las notas dicen lo que el motor no puede
  ocultar —los nombres de `pg_catalog` en PostgreSQL, la lista de bases de
  datos de SQL Server (se ofrece, comentado, revocar `VIEW ANY DATABASE`)— y
  que `export` no tiene equivalente en la base de datos. HuginnDB nunca lo
  ejecuta: el diálogo ofrece Copiar y Guardar. Ver el gotcha #98 de `CLAUDE.md`.

- **La política gestionada se puede editar desde HuginnDB en lugar de a
  mano.** Era un JSON que un administrador escribía en una carpeta compartida,
  y una errata bloqueaba todos los equipos, porque la política falla cerrada.
  Ajustes → Política → **Editar política** la abre como un formulario —roles y
  sus reglas (servidor, bases de datos, tablas, qué pueden hacer la persona y su
  IA, su usuario de base de datos), cuentas, rol por defecto— con el JSON a un
  clic; los dos editan un único borrador, y un campo que esta versión no conoce
  se conserva tal cual. Cada cambio lo comprueba el analizador que aplica la
  política, y un borrador no válido no se puede guardar. **Ver como** enseña lo
  que tendría cualquier cuenta y su IA en cada conexión guardada con el
  borrador. El servidor de una regla se elige entre las conexiones guardadas, y
  sus bases de datos y tablas del catálogo de ese servidor (al que se puede
  conectar desde la propia regla); también se puede añadir un patrón como
  `v_factura_*`, y el campo dice con qué nombres reales coincide antes de
  añadirlo. Quién puede
  guardar lo decide la carpeta compartida: el editor solo guarda donde Windows
  deja a la cuenta escribir en la carpeta de la política, y en el resto es de
  solo lectura con el motivo de Windows. Al guardar se conserva un `.bak`,
  nunca se sobrescribe un cambio que otra persona hizo mientras tanto (tu texto
  va al portapapeles) y se aplica aquí al instante. **Crear política** pone en
  marcha una organización sin política a partir de una plantilla que mantiene
  dentro a quien la crea, y da el comando `reg add` y el valor de directiva de
  grupo; una política incrustada se pasa a un fichero igual. Ver el gotcha #100
  de `CLAUDE.md`.

### Cambiado

- **Preferencias se reagrupa, se puede buscar y enseña lo que has cambiado.**
  El diálogo había crecido hasta catorce secciones en un rail plano, cada
  una maquetada a su manera. El rail ahora va agrupado —Espacio de trabajo,
  Datos y compartición, Integraciones, Organización, con Acerca de fijo
  abajo—, una línea por entrada, y dice lo que antes había que abrir una
  sección para saber: cuántas conexiones expone el conector MCP y muestrea
  Pulse, y si el panel de IA está activo. Un buscador arriba encuentra
  cualquiera de los ~65 ajustes por nombre, descripción o palabra clave (en
  los dos idiomas, sin importar las tildes); Intro abre la primera
  coincidencia en su fila, y Escape borra la búsqueda antes de cerrar el
  diálogo. Todas las secciones abren ahora con la misma cabecera, y las
  listas largas se dividen en tarjetas con título (Editor en *Tema y
  tipografía*, *Visualización*, *Formato*; Conexiones en *Límites de pools*,
  *Actividad y tiempos de espera*, *Conector MCP*; etcétera). Un ajuste que
  has movido de su valor por defecto lleva un punto y un reset de un clic, la
  cabecera de la sección los cuenta con un *Restablecer sección* que pide
  confirmación, y el rail marca las secciones que tienen alguno. Los ajustes
  del endpoint de IA y el idioma de la interfaz quedan fuera a propósito:
  describen tu instalación, no un retoque, y «restablecer» apuntaría el panel
  a otro servidor o te pasaría al inglés. Los rails de los editores de
  orígenes compartidos y de política adoptan el mismo estilo de entrada, ya
  que los tres comparten componente. Todas las secciones siguen ahora la
  misma estructura, también las compuestas: en Apariencia, la lista y el
  editor de temas son una sola tarjeta en lugar de dos cajas juntas; en JSON
  Schemas, la biblioteca, los bindings y la prueba de columna son tarjetas con
  título y sus acciones en la cabecera; Orígenes presenta así sus registros y
  sus formularios; y Política y Acerca de dejan sus cajas dibujadas a mano.
  Las listas de conexiones de MCP, Pulse y el panel de IA, que dibujaban cada
  una su propia copia del mismo selector de ámbito, filtro y botón masivo,
  comparten ahora una tarjeta con esa barra dentro. Los verdes y ámbar fijos
  de esas secciones usan ahora los colores de éxito y aviso del tema, así que
  un tema personalizado también los cambia.

- **Ahora todos los botones tienen un borde visible.** Los botones de icono de
  las barras y los botones `ghost` no se veían hasta pasar el ratón por
  encima, así que una acción como Refrescar o Exportar parecía un icono suelto
  junto a la rejilla. Todos llevan ahora un filete de 1 px sacado del color
  del texto, no del token de borde del tema, para que siga viéndose en temas
  de VS Code importados cuyo color de borde es casi invisible. Los botones
  rellenos (Ejecutar, Guardar, Borrar) llevan un borde en un tono más oscuro
  de su propio relleno y un brillo interior tenue, en lugar del antiguo
  contorno de 2 px y la elevación al pasar el ratón. Las esquinas pasan a la
  escala de `--radius`: 10 px a tamaño completo y 8 px en los botones densos
  y de icono. Los controles densos se quedan planos a propósito: las acciones
  de fila que aparecen al pasar el ratón, la cruz dentro de un chip de filtro
  o de un buscador, los menús de la barra superior y los controles en línea.
  Enmarcarlos sería meter una caja dentro de otra. `Button` e `IconButton`
  aceptan para ello una prop tipada `flat`, que `revealOnHover` activa sola.

- **Sesenta botones hechos a mano pasan a usar `Button` e `IconButton`.**
  Toman la misma altura, hover, anillo de foco y borde que el resto de la
  app, y los botones de icono muestran el tooltip propio de la app en lugar
  del del sistema operativo. Casi todo el cambio es invisible; lo que se
  nota: la barra de estado, la barra de actividad, la campana de
  notificaciones y los conmutadores de disposición son controles de verdad
  con tooltips del tema; el rango 24 h / 7 d / 30 d de Pulse y el selector de
  conflictos al importar son controles segmentados, así que cada uno es una
  sola parada de Tab y se mueve con las flechas; el chevron para desplegar
  del árbol de esquema, los botones de borrar índice y clave foránea del
  editor de estructura (que no tenían nombre accesible) y los de duplicar,
  borrar y pantalla completa de la biblioteca de JSON Schema son botones de
  icono con etiqueta, y el de borrar queda apagado hasta pasar el ratón. Las
  cabeceras plegables de los selectores de conexiones de IA, MCP y Pulse
  comparten un primitivo nuevo, `FoldRow`. Lo que sigue hecho a mano queda
  documentado junto a su recuento en `uiAdoption.test.ts`: filas enteras
  clicables, chips por debajo del mínimo de 24 px y los controles de los
  toasts, donde un tooltip del tema quedaría detrás de la notificación.

### Corregido

- **El botón de pantalla completa del editor lateral de celdas ya pone la
  pantalla completa.** Cambiaba el icono y nada más: el panel lateral va
  envuelto en contención de layout por rendimiento, y eso atrapa dentro de él
  cualquier elemento con `position: fixed`, así que el editor «a pantalla
  completa» ocupaba justo el mismo panel en el que ya estaba. Ahora se coloca
  por encima de toda la ventana mientras está maximizado y vuelve al panel con
  el mismo texto al salir (con el botón, F11 o Escape), y guardar o descartar
  la celda también sale de pantalla completa, para que la siguiente celda no
  se abra maximizada.

- **Insertar o duplicar un documento de MongoDB desde la rejilla respeta el
  tipo de cada campo.** Una fila añadida con el borrador de inserción de la
  rejilla, o duplicada a partir de otra, se escribía con todos los campos como
  cadena: un `Long` como `atnId: 5` pasaba a ser `"5"`, y los booleanos y las
  marcas de tiempo corrían la misma suerte. La rejilla sí enviaba el tipo de la
  columna junto a cada valor, pero el backend leía esa pista con otro nombre y
  la descartaba, así que la inserción acababa en texto. La misma pista perdida
  afectaba a las actualizaciones masivas y a las columnas binarias de SQL
  Server escritas desde un borrador de inserción. Editar una celda ya existente
  nunca se vio afectado.

- **El buscador de la rejilla y el selector de clave foránea hablan el idioma
  de la interfaz.** Con la aplicación en español, los botones de borrar y de
  búsquedas recientes del buscador seguían anunciándose en inglés, y el
  selector de clave foránea de los borradores de inserción mostraba en inglés
  su texto de ayuda, «Loading…», «No matches», el aviso de «mostrando las
  primeras N filas» y el tooltip de fallo de la búsqueda, igual que la marca
  «auto» de una columna de clave autogenerada en el borrador de inserción.
  Ahora todos salen de los ficheros de idioma, en inglés y en español.

- **Un control segmentado sin nada seleccionado vuelve a alcanzarse con Tab.**
  Los controles segmentados dejan en el orden de tabulación solo el segmento
  seleccionado, así que cuando el valor actual no coincidía con ninguno —una
  duración personalizada escrita junto a los valores predefinidos de las
  notificaciones, por ejemplo— se saltaban todos los segmentos y el control
  entero quedaba fuera del alcance del teclado. Ahora, si no hay nada
  seleccionado, el primer segmento recibe la parada de Tab, como corresponde a
  un grupo de opciones, y las flechas avanzan desde el segmento que tiene el
  foco y lo arrastran con la selección en lugar de dejarlo atrás. Los valores
  predefinidos de duración de Ajustes → Notificaciones usan ahora este control
  en lugar de botones propios, así que también se alcanzan y se recorren con
  las flechas; adoptan su estilo neutro en relieve en lugar del relleno de
  marca.

- **«Editar en el origen» en el gestor de conexiones ya no apila encima el
  editor de orígenes.** El enlace que recibe quien publica un origen en una de
  sus conexiones abría el editor de orígenes, a pantalla completa, con el
  gestor de conexiones —también a pantalla completa— abierto debajo: la
  combinación que atrapa el foco del teclado en el último de los dos que se
  abrió. Ahora el gestor se aparta mientras el editor está abierto y vuelve en
  la misma conexión al cerrarlo, guardando o sin guardar; lo mismo cuando el
  aviso de republicación pasa un conflicto al editor. Los cambios sin guardar
  del formulario del gestor no sobreviven al viaje: vuelve con la conexión tal
  y como está guardada. El botón «Nueva conexión» del espacio de trabajo vacío
  abre ahora el gestor del menú Archivo en lugar de una copia propia, que es lo
  que permite al editor alcanzarlo, y conectar desde ahí selecciona la nueva
  conexión, como ya hacía el menú. Ver el gotcha #101 de `CLAUDE.md`.

- **Los errores del conector MCP ya no repiten su prefijo con la app
  abierta.** Con la aplicación de escritorio en marcha, el conector le delega
  el trabajo, y un rechazo volvía duplicado —`invalid input: invalid input:
  "payroll" … is not available to the AI`— porque el error de la app, ya
  redactado, se envolvía en otro nuevo por el camino. Ahora se lee igual que
  cuando el conector trabaja por su cuenta. Los fallos propios del puente (la
  app no responde a tiempo o cierra antes de responder) pierden también un
  `invalid input:` que nunca les correspondió.

- **Al salir del editor de orígenes compartidos se vuelve a Ajustes.** Abrir el
  editor desde Ajustes → Orígenes cerraba Ajustes, como debe ser: no se pueden
  apilar dos diálogos a pantalla completa. Pero al salir del editor, guardando
  o sin guardar, acababas en la ventana principal. Ahora Ajustes se aparta
  mientras el editor está abierto y vuelve en Orígenes al cerrarlo. Si el
  editor se abre desde el aviso «editar en el origen» de una conexión, Ajustes
  sigue cerrado al salir. El nuevo editor de la política funciona igual. Ver el
  gotcha #101 de `CLAUDE.md`.

- **Una política gestionada ya no se rompe cinco minutos porque la carpeta
  compartida parpadee.** Una política en vigor que un instante no se podía
  leer —la carpeta no respondía, u otro equipo estaba sustituyendo el fichero
  justo entonces— se daba por rota en el acto, y una política rota bloquea
  todas las conexiones hasta la siguiente lectura, cinco minutos después.
  Ahora una política que estaba en vigor se vuelve a leer unas cuantas veces
  antes de darla por rota; una que se lee pero no es válida sigue rota al
  momento, porque leerla otra vez solo lee el mismo error. Llega a la vez la
  base del editor de la política en la app: la abre, la comprueba, la
  previsualiza para cualquier usuario y la guarda con las salvaguardas del
  editor de orígenes (una prueba de escritura real en la carpeta, la detección
  de conflictos contra el fichero tal como se abrió y un `.bak`) y un
  reemplazo que nunca deja la ruta sin fichero. Ver el gotcha #99 de
  `CLAUDE.md`.

- **Una colección de MongoDB vacía seguía sin poder recibir su primer
  documento.** La 1.25.0 arregló la mitad: `infer_columns` siembra `_id` como
  clave primaria cuando la muestra sale vacía. Pero la condición de escritura
  del grid (`hasPk` de `TableDataTab`) exige además que todas las columnas de
  la clave estén en el *resultado del browse*, y el browse construye sus
  columnas a partir de los documentos que devuelve —cero documentos, cero
  columnas—, así que `_id` se sabía clave y aun así faltaba en la página, y
  Insertar seguía oculto. El browse (`fetch_collection_data`) ahora informa de
  una columna `_id` cuando su página está vacía, la contrapartida en MongoDB
  del recurso al catálogo que los drivers SQL recibieron en #27. También cubre
  un filtro que no coincide con ningún documento, que ocultaba Insertar de la
  misma forma. Las consultas ad hoc no cambian: un `find` vacío en el editor
  sigue sin informar de columnas.

### Seguridad

- **Documentado: la política gestionada da por hecho un único dominio de
  Windows.** Las cuentas se comparan sin el dominio, así que
  `ITBACKING\alopez` y `CLIENTE\alopez` son el mismo usuario para la
  política y reciben el mismo rol. `docs/POLICY.md` ya lo dice, y avisa de no
  desplegar la política en un bosque de dominios de confianza con nombres de
  cuenta que se repiten hasta que se compare también el dominio.

- **Tres sentencias que escriben se clasificaban como lecturas y se ejecutaban
  con una política de solo lectura.** El nivel que necesita una sentencia —lo
  que comprueban una conexión MCP `read-only` y la regla de no escritura del
  panel de IA— se decide a partir de su texto, y tres formas parecían un
  `SELECT` por su primera palabra:
  - un `WITH` con DML: Postgres ejecuta `WITH d AS (DELETE FROM t RETURNING *)
    SELECT * FROM d`, y Postgres y MySQL 8 aceptan un `WITH` delante de un
    `INSERT` / `UPDATE` / `DELETE`;
  - `EXPLAIN ANALYZE`, que en Postgres y MySQL *ejecuta* la sentencia que
    mide: `EXPLAIN ANALYZE DELETE …` borra;
  - un `aggregate` de MongoDB que termina en `$out` (sustituye una colección) o
    en `$merge` (escribe en una), clasificado solo por el nombre del método.

  Las tres reciben ahora el nivel de lo que hacen: un `WITH` con una palabra
  clave de DML en su código es una escritura de datos (se ignoran literales,
  nombres entre comillas y comentarios, y también `FOR UPDATE` y el `MERGE JOIN`
  de T-SQL), `EXPLAIN ANALYZE` toma el nivel de la sentencia que ejecuta
  mientras que un `EXPLAIN` normal sigue siendo lectura, `$out` es DDL y
  `$merge` una escritura de datos. De paso, `WITH … INSERT INTO …` deja de
  contar como DDL por su `INTO`, lo que lo dejaba fuera del alcance de una
  conexión `data` que sí puede insertar.

  **Y ahora también lo hace cumplir la base de datos.** Una sentencia que envía
  una IA y que se clasifica como lectura se ejecuta dentro de una transacción de
  solo lectura en PostgreSQL y MySQL, y con `PRAGMA query_only` en SQLite, así
  que una escritura que se le escape al clasificador falla en el servidor en vez
  de ejecutarse. Límites, dichos claramente: SQL Server no tiene transacciones
  de solo lectura ni MongoDB un modo equivalente, así que esos dos dependen solo
  del clasificador; y en MySQL un DDL hace commit implícito antes de ejecutarse,
  así que ahí la barrera frena el DML, no el DDL. Ver el gotcha #93 de
  `CLAUDE.md`.

## [1.28.0] — 2026-09-23

### Añadido

- **Explicar, desde el panel de consulta.** La línea *Resultado* tiene un
  botón **Explicar**: el plan que usaría el borrador del panel, leído sin
  ejecutarlo, en un recuadro de altura limitada bajo la sentencia. Es la
  respuesta del propio motor —`EXPLAIN (FORMAT JSON)` en PostgreSQL,
  `EXPLAIN FORMAT=JSON` en MySQL, `EXPLAIN QUERY PLAN` en SQLite y el `explain`
  de MongoDB con verbosidad `queryPlanner`—, mostrada como JSON igual que ya lo
  hace Pulse. El plan SQL se lee de la misma sentencia de página que ejecuta la
  navegación, con sus valores enlazados reales, así que es el plan de lo que se
  ejecuta, con collation, hint y proyección incluidos. Un plan leído para un
  borrador se descarta en cuanto el borrador cambia. SQL Server se rechaza con
  el motivo: su plan necesita `SHOWPLAN` en un lote propio, que el panel aún no
  puede emitir.

- **Collation e índice (hint), por navegación.** La fila **Avanzado** del
  panel de consulta —plegada a una línea hasta que se abre— fija dos cosas que
  el planificador y el orden deciden normalmente por su cuenta:

  - **Collation.** En SQL se aplica a cada clave del orden, escrita como la
    nombra cada motor (`COLLATE "es-ES-x-icu"` en PostgreSQL,
    `utf8mb4_spanish_ci` en MySQL, `Latin1_General_CI_AS` en SQL Server, y un
    selector con las tres de SQLite). En MongoDB es un documento de collation
    (`{ locale: 'es', strength: 1 }`) que el servidor aplica al filtro *y* al
    orden, así que también lo lleva el recuento: con `strength: 1`, «a» y «A»
    son el mismo valor. Una collation no puede ir como parámetro enlazado, así
    que los nombres se validan antes de insertarlos.
  - **Índice (hint).** Un selector con los índices de la propia tabla. La
    navegación lo fuerza (`FORCE INDEX` en MySQL, `INDEXED BY` en SQLite,
    `WITH (INDEX(…))` en SQL Server, `hint()` en MongoDB), y todos fallan en
    lugar de ignorar un índice que ya no existe: lo honesto para algo que se ha
    fijado a propósito. PostgreSQL no admite hints de índice, así que ahí el
    selector aparece desactivado y lo explica.

  Los dos aparecen en la línea *Resultado*, se exportan, se guardan con la
  pestaña y se muestran como chip **Avanzado** mientras están activos. La
  gramática de la pestaña de consulta de MongoDB aprendió también
  `.collation(…)` y `.hint(…)`, así que *Abrir en el editor* sigue entregando
  algo que se ejecuta tal cual, y el `explain` de Pulse los incluye.

- **Escribe el filtro a mano, y mira la consulta que lanza.** La fila
  *Filtro* del panel de consulta admite una **expresión** junto a sus
  condiciones: una condición tal como la escribirías tras el `WHERE` en SQL, o
  un documento de filtro en MongoDB con la sintaxis de la pestaña de consulta
  (claves sin comillas, `ObjectId(…)`, `ISODate(…)`, expresiones regulares).
  Se combina con AND con las condiciones, los chips y la búsqueda en lugar de
  sustituirlos, así que no hay que convertir nada entre las dos formas y los
  chips siguen correspondiéndose uno a uno con las filas del panel. Mientras
  está activa aparece como chip **Expresión**, y cuenta para el recuento, la
  exportación y la pestaña guardada como todo lo demás del panel.

  Una expresión SQL tiene que seguir siendo una sola condición. El panel
  rechaza un `;` fuera de una cadena o un comentario, los paréntesis
  desequilibrados y una cadena o un `/* comentario` sin cerrar: las tres formas
  en que un fragmento insertado en el `SELECT` de la navegación podría
  terminarlo antes de tiempo, escaparse del `AND` o tragarse el `LIMIT`. No es
  una barrera de seguridad: la pestaña de consulta de al lado ejecuta
  cualquier cosa.

  Una fila nueva, **Resultado**, muestra la sentencia que lanzaría el
  borrador del panel, construida por el mismo código del backend que usa la
  navegación, así que no puede decir otra cosa que lo que se ejecuta. Ocupa
  una sola línea; su botón de desplegar abre la sentencia formateada en un
  recuadro de altura limitada, para que un filtro largo de MongoDB no empuje
  las filas fuera de la vista. En SQL
  los valores aparecen incrustados, solo para leerlos. MongoDB se muestra
  como un `db.<colección>.find(…)` con la gramática de la pestaña de consulta.
  **Copiar** y **Abrir en el editor** la llevan a otro sitio; lo segundo abre
  una pestaña de consulta que la ejecuta tal cual: la salida para todo lo que
  el panel no sabe expresar. Una expresión que no se puede interpretar
  muestra ahí su error, y Aplicar queda desactivado hasta que se corrija.

  *Actualización masiva* no puede llevar una expresión (su lado de
  coincidencia solo admite condiciones), así que mientras hay una activa lo
  avisa encima de sus condiciones.

- **Ir a fila.** El pie de la tabla admite un número de fila y mueve la página
  para que empiece ahí: la fila 250 muestra 250–349, el mismo rango en que ya
  cuenta el pie. Es la respuesta de la tabla al *Skip* de Compass: unos campos
  Skip y Limit aparte se habrían peleado con el paginador por el mismo
  desplazamiento.

- **Proyección: elige qué campos devuelve una tabla o una colección.** El
  panel de consulta tiene una segunda fila. En SQL es **Columnas** (*Todas* /
  *Elegir*); en MongoDB es **Proyección** (*Todos* / *Incluir* / *Excluir*).
  La navegación pide entonces al servidor solo esos campos —una lista en el
  `SELECT`, o el documento de proyección de `find()`—, así que una tabla con
  una columna JSON o de texto muy ancha, o una colección cuyos documentos
  llevan un subdocumento grande, deja de traerlo en cada página.

  La clave siempre vuelve. Toda edición localiza una fila por su clave
  primaria y un documento por su `_id`, así que el panel los muestra
  bloqueados en lugar de ofrecer una elección que dejaría las filas en solo
  lectura, y `_id` no se puede excluir. Las rutas que MongoDB no acepta juntas
  (`meta` con `meta.plant`) dejan de ofrecerse en cuanto se elige una de
  ellas. Mientras hay una proyección activa, un chip **Campos** en la fila de
  chips la nombra, abre el panel, y su ✕ vuelve a devolver todos los campos
  —una columna que falta sin motivo visible parece un fallo—. *Duplicar fila*
  no está disponible mientras tanto, porque la copia perdería sin avisar los
  valores de las columnas ocultas. La proyección se guarda con la pestaña,
  como sus filtros y su orden.

- **«Exportar resultados» escribe lo que muestra la tabla.** Ya respetaba los
  filtros. Ahora respeta también el orden (el fichero sale en el orden de la
  tabla) y la proyección. Los `INSERT` de una exportación SQL nombran solo las
  columnas proyectadas, así que las demás toman su valor por defecto al
  volver a cargarse; una exportación de MongoDB escribe los documentos
  proyectados.

- **Ordenar en la vista de lista, y un orden que se ve en los dos modos.** El
  orden de la navegación siempre se aplicó en el servidor y seguía aplicándose
  en la vista de lista, pero la única forma de ponerlo era hacer clic en la
  cabecera de una columna, y la vista de lista no tiene cabeceras. Una colección
  ordenada en modo tabla seguía ordenada en modo lista sin que nada en pantalla
  lo dijera, y una colección abierta en modo lista no se podía ordenar. Quien
  venía de MongoDB Compass buscaba su campo Sort y no encontraba nada.

  El orden tiene ahora tres puntos de entrada que funcionan en los dos modos de
  vista y con todos los drivers:

  - Un botón **Ordenar** (⇅) en la barra de la tabla, junto al filtro avanzado.
    Muestra las columnas de la tabla (en MongoDB, los campos de la página,
    incluidas las rutas anidadas) y construye un orden de varios niveles campo a
    campo. Lleva el mismo contador que el botón de filtro.
  - **Chips de orden** junto a los de filtro. Un clic invierte la dirección y
    la ✕ lo quita. Si hay más de un nivel muestran su posición. En modo tabla
    también mantienen visible un orden cuando su columna se ha desplazado fuera
    de la vista.
  - Un **menú contextual en cada campo** de la vista de lista: *Ordenar
    ascendente / descendente por …* (sustituye el orden, como un clic normal en
    la cabecera; el menú de la barra es el que añade niveles), *Quitar … del
    orden*, *Filtrar por este valor* y *Filtrar excluyendo este valor*, que la
    vista de lista nunca había tenido, y *Copiar*.

  En MongoDB un campo anidado se ordena y se filtra por su ruta con puntos.
  Dentro de un array se prescinde del índice, como ya hacía el filtro avanzado:
  `items.0.sku` ordena por `items.sku`, porque `sort()` no entiende un índice
  posicional, y filtrar por un elemento de `tags` pide los documentos cuyo
  `tags` lo contiene. En SQL solo los campos de primer nivel tienen estas
  opciones, porque `ORDER BY` y `WHERE` nombran una columna. Es el primer paso
  de la barra de consulta que pidieron los usuarios (la proyección, el filtro en bruto y
  el resto llegan en versiones posteriores). El backend no cambia: ya aceptaba
  todo lo que envían estos controles.

### Cambiado

- **El filtro avanzado es ahora un panel bajo la barra, no un diálogo.** El
  botón de filtro (en el mismo sitio y con el mismo contador) abre y cierra una
  sección **Consulta** entre la barra y las filas. Tiene la misma lista de
  condiciones en AND que el diálogo, con el mismo selector de campo, los mismos
  operadores y los mismos tipos de valor de MongoDB. Las filas que filtra siguen
  a la vista debajo, en lugar de quedar detrás de un modal. Hacer clic en un
  chip de filtro lo abre en la condición de ese chip, como antes.

  Nada llega al servidor hasta **Aplicar** (o Ctrl/⌘+Enter dentro del panel).
  Si los filtros cambian desde fuera con el panel abierto (la ✕ de un chip, un
  *Filtrar por este valor* con clic derecho), un panel que dice lo mismo que lo
  aplicado los sigue. Un panel cuyo borrador es distinto conserva tus cambios y
  avisa de *Cambios sin aplicar* —es una comparación, así que deshacer un
  cambio lo quita—; **Restablecer** vuelve a lo que está en vigor. Cerrar el panel descarta los
  cambios sin aplicar, como hacía cancelar el diálogo.

  Es la superficie donde crecerá el resto de la barra de consulta: la
  proyección, un filtro en bruto y una vista previa de la consulta que se va a
  lanzar. El diálogo se retira en lugar de convivir con el panel, para que
  haya un único sitio que edite los filtros activos.

- **Los chips de filtro y de orden tienen una fila propia bajo la barra.**
  Antes iban en línea tras el buscador, compitiendo por la misma línea con la
  búsqueda y con todas las acciones. A partir de un ancho medio de panel se
  plegaban en un único chip «N filtros», que ocultaba las condiciones justo
  cuando había suficientes como para importar. La fila nueva lleva la etiqueta
  *Filtros · Orden*, solo aparece cuando hay algo que mostrar y hace salto de
  línea en vez de plegarse. Los chips de resumen desaparecen.

### Corregido

- **«Exportar resultados» en MongoDB ignoraba la búsqueda de texto libre.**
  Aplicaba los chips de filtro pero se saltaba el buscador, así que una
  exportación hecha mientras se buscaba escribía documentos que la tabla no
  estaba mostrando. Ahora usa el mismo filtro que la navegación.

- **El selector de clave foránea seguía ofreciendo una clave que ya no
  existía.** Si cambiabas una clave primaria (`5` → `50`) y luego editabas una
  celda que la referencia, el selector seguía mostrando `5` y el `50` no
  aparecía por ningún lado. Ni F5 ni volver a abrir la tabla lo arreglaban. El
  selector guardaba en caché los valores referenciados la primera vez que se
  abría y no volvía a pedirlos en toda la sesión. Ahora sigue mostrando al
  instante la lista en caché, pero cada vez que se abre vuelve a leer la tabla
  referenciada y la sustituye por la lista nueva, así que un cambio hecho desde
  la tabla, el editor SQL u otro cliente aparece en la siguiente apertura. Si
  esa lectura falla, te quedas con la lista que tenías en vez de un cuadro de
  texto libre. Las opciones en caché también se descartan ahora al
  desconectar, incluidas las de las bases de datos que abrió una sesión
  multi-BD. Esa limpieza ya existía; simplemente nadie la llamaba.

## [1.27.0] — 2026-09-23

### Añadido

- **La sentencia `CREATE` de la tabla, lista para copiar, en el editor de
  estructura.** Quien venía de HeidiSQL buscaba su pestaña de *código CREATE* y
  no encontraba nada equivalente: el único SQL en pantalla era la vista previa
  DDL, que es el *diff* de los cambios pendientes, no lo que la tabla es. El
  editor de estructura tiene ahora una cuarta sección, **CREATE**, con la
  definición tal cual la guarda el servidor —el `SHOW CREATE TABLE` de
  MySQL/MariaDB (motor, charset, collation, comentarios y particiones
  incluidos) y el texto de `sqlite_master` en SQLite, seguido de los índices y
  triggers de la propia tabla— con un botón **Copiar**. Se refresca al recargar
  y tras un Aplicar con éxito, nunca a partir de cambios sin guardar.

  En PostgreSQL y SQL Server no aparece, a propósito. Ninguno de los dos guarda
  la sentencia, así que habría que reconstruirla desde el catálogo, y el
  constructor que usa el editor pierde lo que `TableStructure` no lleva
  (comentarios, `CHECK`s, opciones de tabla). Una sentencia «lista para pegar»
  que está incompleta sin avisar es peor que no tener ninguna.

- **Un tiempo máximo de operación configurable por conexión.** Desplegar el
  árbol en un SQL Server con varios cientos de bases de datos fallaba con
  *«list_databases took longer than 20s — the connection may be unresponsive»*,
  en una conexión que se había abierto en menos de un segundo. El servidor no
  estaba muerto: era grande. `sys.databases` filtrado por `HAS_DBACCESS` evalúa
  una comprobación de permisos por base de datos, y no había forma de decirle a
  la app que esperase.

  Los veinte segundos eran una constante, es decir, una afirmación sobre un
  servidor que HuginnDB no ha visto nunca. Ahora son el valor *por defecto*:
  **Ajustes → Conexiones → Tiempo máximo de operación** lo fija globalmente, y
  **Tiempo máximo de operación para este servidor**, en el diálogo de conexión,
  lo pisa para una sola conexión, junto al techo de pools que responde a la misma
  clase de pregunta. En blanco significa la preferencia global.

  Solo acota las lecturas que la app hace por su cuenta — listar bases de datos y
  tablas, describir una relación, el ping de comprobación. Una consulta que
  lances **tú** nunca ha tenido tope y sigue sin tenerlo. Igual que el techo de
  conexiones, viaja con el perfil, así que llega a las exportaciones, a los
  orígenes compartidos y al conector MCP sin configurar nada más.

  Además, el error ahora nombra la solución en vez de describir una conexión
  rota que el usuario se pone a buscar.

- **Un tipo de valor por condición de filtro, en MongoDB.** Un default mejor
  sigue siendo un default: una colección sin esquema puede guardar legítimamente
  un `long` en unos documentos y una cadena en otros, y ningún muestreo resuelve
  eso. Cada condición lleva ahora su propio **Auto / Texto / Número / Long /
  Booleano / Fecha / ObjectId**, con Auto por defecto — que es exactamente lo
  que el filtro hacía antes.

  Dos de ellos hacen algo que ninguna inferencia podía. **Long** conserva los
  dígitos como texto, así que un valor por encima de 2^53 no se redondea en
  silencio al pasar por JavaScript. **ObjectId** es la única manera de filtrar
  un ObjectId guardado en un campo que no sea `_id`, que hasta ahora no se podía
  filtrar.

- **Los chips de filtro muestran de qué tipo es realmente el valor** en MongoDB:
  una cadena va entrecomillada, y las formas tipadas se leen `ObjectId("…")`,
  `ISODate("…")`, `NumberLong("…")` — la grafía de la propia shell, y la que ya
  usa el log de la consola. `value <> 5682380` y `value <> "5682380"` son
  preguntas distintas y se pintaban igual, que es lo que permitió que el bug
  original se escondiera a plena vista. Los chips de SQL no cambian: ahí el
  valor es un parámetro enlazado que se convierte contra su columna, así que la
  distinción no existe.

- **Al eliminar una tabla se nombran las tablas que la referencian, antes de
  confirmar.** El diálogo de borrado no decía nada de claves foráneas, así que
  el primer aviso era el servidor rechazando el borrado. Y ese rechazo ayuda
  poco: en MySQL 5.7 y MariaDB (1217/1451, *«a foreign key constraint fails»*)
  no nombra ninguna tabla, y el 3730 de MySQL 8.0 nombra solo una de las
  posibles. Ahora el diálogo busca todas las claves foráneas de *otras* tablas
  que apuntan a esta y las lista como `tabla (columnas) → constraint`, con el
  esquema cuando la tabla vive en otro. Las autorreferencias quedan fuera,
  porque no impiden el borrado. Funciona en MySQL/MariaDB, PostgreSQL, SQLite y
  SQL Server.

  La consulta es orientativa y nunca bloquea el botón. Si falla, el diálogo
  simplemente no muestra nada, y la última palabra sigue siendo del servidor:
  las comprobaciones de FK pueden estar desactivadas, y PostgreSQL tiene
  `CASCADE`.

### Corregido

- **Un filtro de MongoDB ya no hace la pregunta equivocada sobre un campo cuyo
  tipo almacenado ha cambiado.** `value <> 5682380` dejaba en pantalla justo las
  filas que debía excluir, y la consola enseñaba por qué: el valor salía como
  `Int32` mientras la cabecera del grid, justo encima, etiquetaba esa columna
  como `STRING`.

  Una columna de MongoDB se tipa dos veces, a partir de dos poblaciones
  distintas. La cabecera la tipa desde la página que hay en pantalla; el filtro
  avanzado la tipaba desde el muestreo de 100 documentos que el catálogo hace de
  la colección entera. En un campo que antes guardaba números y ahora guarda
  cadenas, esas dos respuestas no coinciden — y la igualdad BSON es exacta por
  tipo, así que un `$ne` contra la equivocada no excluye nada y no avisa de
  nada. Cada paso era correcto por separado; simplemente la pantalla no podía
  explicar el resultado.

  El filtro usa ahora la respuesta de la página, la misma que pinta la
  cabecera, y recurre al catálogo cuando la página no puede decidir (un campo
  que se contradice entre filas, o que está a null en todas). No cambia nada en
  PostgreSQL, MySQL, SQLite ni SQL Server, donde el tipo del catálogo es
  autoritativo y no un muestreo.

## [1.26.1] — 2026-09-18

### Añadido

- **«Editar conexión…» en el menú contextual de una conexión.** Cambiar el
  host, el puerto o el usuario de una conexión guardada obligaba a ir a
  Archivo → Gestionar conexiones y volver a buscar la fila en una lista que
  fácilmente tiene cincuenta — partiendo de un nodo del árbol que ya sabía
  exactamente de qué conexión hablabas. Ahora el gestor se abre directamente
  sobre ella. También se ofrece con la conexión desconectada, que es cuando
  más falta hace: una conexión que no abre es justo la que quieres corregir.
  
### Corregido

- **Un tema de VS Code importado llega por fin a los editores SQL.** Se
  apilaban dos fallos y, entre los dos, la mitad de editor de un tema
  importado era inalcanzable.

  Elegir uno en Ajustes → Editor reventaba el panel entero: la vista previa
  leía los colores del catálogo integrado, del que un id importado no es
  clave, así que desreferenciaba `undefined` y se llevaba por delante todo el
  diálogo de Ajustes.

  Y aun eligiéndolo con éxito, nunca se aplicaba. Las definiciones de un tema
  importado se leen de `installed_themes.json` en una llamada asíncrona
  *posterior* al primer pintado, así que un editor que montara en esa ventana
  degradaba el id al tema por defecto — con razón, porque Monaco lanza un
  error con un id que nadie ha definido — y nada lo recuperaba, porque el id
  se calculaba a partir de un registro a nivel de módulo al que ningún
  componente estaba suscrito. El resultado: todos los editores de la app
  clavados en HuginnDB Dark durante toda la sesión mientras la interfaz
  mostraba la paleta importada. Ahora el id se deriva del store de temas, de
  modo que la misma actualización que registra las definiciones repinta los
  editores.

- **Instalar un tema ahora también tematiza el editor.** La interfaz se
  quedaba con la paleta importada y el editor se quedaba donde estaba, sin
  nada en la UI que dijera que eran dos ajustes distintos. Instalar o
  actualizar un tema apunta el editor a los colores de editor de esa misma
  extensión, un cambio claro/oscuro sigue a la familia a su otra variante, y
  borrar un tema saca al editor del id que acaba de dejar de existir. Un
  editor puesto a propósito en un tema del catálogo — Monokai, GitHub Dark,
  un integrado de VS — no se pisa nunca: esa es una elección tomada al margen
  de la interfaz.

- **Dejar el puerto en blanco ahora significa «el predeterminado de este
  driver» en vez de puerto cero.** Una conexión guardada sin puerto se marcaba
  tal cual — `host:0` — y volvía como conexión rechazada citando un puerto que
  nunca escribiste. Un campo de puerto vacío se resuelve ahora a 5432 / 3306 /
  27017 / 1433 al conectar, y el campo muestra ese número en gris para que
  quede claro qué va a pasar si lo dejas vacío. Lo mismo vale para un
  arranque por CLI sin `--port` y para un perfil importado que lo omita.

  El puerto **no** se escribe en el perfil: `profiles.json` sigue registrando
  que no elegiste ninguno, así que la conexión sigue el predeterminado del
  driver en lugar de congelar el valor de hoy, y una conexión compartida por
  un origen no propaga un número que su publicador nunca introdujo.

- **Las instancias nombradas de SQL Server se descubren por el SQL Browser,
  esta vez de verdad.** La consulta se enviaba al puerto TCP de la propia
  instancia en lugar de al UDP 1434 del Browser, así que siempre caducaba y la
  conexión solo funcionaba si además habías escrito el puerto estático de la
  instancia, que se usa como alternativa. Una instancia en puerto dinámico no
  había forma de alcanzarla. Ahora `SERVIDOR` + nombre de instancia con el
  puerto en blanco conecta, igual que en SSMS.

## [1.26.0] — 2026-09-17

### Añadido

- **Las claves de traducción que faltan ahora rompen los tests.** Una clave
  referenciada por el código pero ausente del fichero de idioma se mostraba
  como la propia clave, y solo lo veía quien mirase ese botón: TypeScript no
  comprueba el argumento de `t()` y ningún test montaba todos los componentes.
  `src/lib/i18n/keys.test.ts` valida cada `t("…")` literal contra ambos idiomas
  y que los dos tengan las mismas claves.

- **Un panel de Extensiones: explorar Open VSX desde dentro de la app.** Un
  nuevo ocupante del panel lateral derecho, junto a Consultas guardadas, Pulse
  y el panel de IA. Busca en el registro, mira qué es cada tema (icono,
  autor, licencia, descargas, cuántas variantes aporta), instálalo de un clic
  y aplícalo sin salir de la ventana. Al instalar se emparejan solas la primera
  variante clara y la primera oscura de la extensión; elegir otras está ahí
  para cuando lo quieras, no antes de cada instalación. Un tema que hayas
  importado a mano desde un `.vsix` también se reconoce en el listado, y recibe
  avisos de actualización, emparejándolo por el identificador de su
  manifiesto.

  Se comprueba si los temas instalados tienen versiones nuevas, y actualizar
  uno **nunca pisa una paleta que hayas editado**: se refresca el tema del
  editor y tus colores se quedan exactamente como los dejaste. El panel avisa
  de a qué temas les aplica esto antes de que pulses nada.

  Algunos detalles que son decisiones y no fontanería:

  - **Los temas de iconos no aparecen nunca.** El registro archiva los temas de
    color y los de iconos bajo la misma categoría `Themes` y su respuesta de
    búsqueda no sabe distinguirlos: solo el manifiesto de cada extensión puede.
    HuginnDB descarga ese manifiesto (1–11 KB, no el paquete entero) y filtra
    con él, así que descartar Material Icon Theme cuesta 11 KB en vez de 6 MB.
    Eso hace además que el recuento de resultados sea aproximado, y el panel lo
    dice con un «unos».
  - **Las descargas se verifican** contra la suma de comprobación que el
    registro publica junto a cada paquete, y se rechazan si no coincide.
  - **Quién decide a dónde conectarse es la app, no el panel.** La URL del
    registro se lee de tus preferencias dentro del backend, así que desactivar
    el explorador en Ajustes → Apariencia lo desactiva de verdad. También
    puedes apuntarlo a tu propia instancia de Open VSX, y cada tema instalado
    recuerda de dónde vino, así que cambiar el ajuste nunca redirige las
    actualizaciones de un tema ya instalado.
  - No sale nada tuyo de la máquina: peticiones anónimas de paquetes públicos,
    sin credenciales, sin telemetría y sin esquemas.

- **Importar un tema de color de VS Code: tu tema en el editor, y una paleta de
  la app derivada de él.** El botón **Importar tema…** de Ajustes → Apariencia
  acepta ahora también un paquete de extensión `.vsix` o un
  `*-color-theme.json` suelto, además de las exportaciones
  `.huginndb-theme.json` que ya admitía. Planteado por David, cuyo punto de
  partida era [open-vsx.org](https://open-vsx.org) — el registro abierto que
  usan Cursor, VSCodium y Gitpod, y el correcto: los términos del marketplace
  de Microsoft prohíben acceder a él desde productos que no sean VS Code.

  Esta versión hace la conversión, sin red. Navegar open-vsx desde dentro de la
  app es un trabajo aparte; lo que entra aquí es todo lo que va por debajo, que
  es la parte que decide si la idea merece el código de red.

  Qué hace realmente un tema importado, dicho sin adornos porque las dos
  mitades no son lo mismo:

  - **El editor recibe el tema tal cual.** Monaco *es* el editor de VS Code, así
    que `tokenColors` y los colores `editor.*` significan aquí exactamente lo
    mismo que allí. Importa Dracula y el editor SQL es Dracula, no una
    aproximación — incluida la selección translúcida, que se conserva en vez de
    aplanarse porque ahí sí está pensada para serlo.
  - **El resto de la app recibe una paleta derivada.** Un tema de VS Code nombra
    ~600 claves según el widget que pinta cada una (`sideBar.background`,
    `list.hoverBackground`); HuginnDB nombra 30 según el papel que cumple cada
    una (`card`, `accent`, `brand`, `pk`/`fk`). Eso es una lectura, no una
    traducción, así que la importación aterriza como un tema personalizado
    normal en el editor de Apariencia, con todos los tokens editables después.
    El diálogo muestra la paleta derivada antes de confirmar.

  Cuatro cosas que la conversión resuelve, todas descubiertas leyendo temas
  reales y no la especificación:

  - **Los archivos de tema son JSON *con comentarios*, y muchos no se parsean
    sin eso.** Dos de los cinco temas que quedan como fixtures de test (Tokyo
    Night y Nord) fallan directamente con `JSON.parse`.
  - **Los colores translúcidos `#RRGGBBAA` se componen al importar**, contra el
    fondo de editor del propio tema — hasta 52 claves en un solo tema. Son
    translúcidos en VS Code porque su renderizador los pinta sobre lo que haya
    detrás; resolver eso una vez al importar es lo que deja intacto el pipeline
    de color de la app.
  - **Las claves que faltan se resuelven dentro del tema, nunca con los valores
    por defecto de VS Code.** Los cinco temas muestreados omiten `menu.*`, y One
    Dark Pro omite además `button.foreground`. Tomar prestados los valores de VS
    Code metería su anillo de foco azul dentro de una importación de Gruvbox;
    en su lugar cada token recorre una cadena de claves relacionadas que el tema
    sí declara, terminando en algo derivado de su propio fondo y su propio color
    de texto.
  - **Una superficie que se resuelve al mismo color del fondo se separa un
    nivel.** Cuatro de los cinco temas muestreados lo hacen al menos una vez:
    la barra lateral de Nord *es* su fondo de editor, y el menú y los campos de
    GitHub Light son blanco puro. Es correcto en VS Code, que separa esos
    planos con un borde; aquí significaría un panel que no está y un campo de
    entrada sin campo. Solo se corrige un colapso real, así que una separación
    sutil que el tema sí declaró se respeta tal cual.
  - **Todos los pares texto/superficie se comprueban por contraste.** VS Code
    puede rescatar un par malo con una excepción por widget y esta paleta no,
    así que un tema cuya superficie de hover casi coincide con su color de texto
    acabaría mostrando una fila seleccionada ilegible.

  Una extensión suele ser varios temas — GitHub aporta nueve variantes, Gruvbox
  seis, One Dark Pro cinco —, así que el diálogo de importación empareja una
  variante clara con una oscura en una sola familia de tema. Elegir solo una
  rellena con ella ambas mitades, en lugar de inventar una paleta que nadie
  diseñó, y lo avisa.

  Los temas de editor importados aparecen en el selector de tema de Ajustes →
  Editor y se borran junto con la familia de tema con la que llegaron.

## [1.25.0] — 2026-09-17

### Añadido

- **El contenido de una celda se formatea nada más abrirla, según su tipo.**
  Ajustes → Editor gana tres interruptores: formatear automáticamente **JSON**,
  **XML** y **SQL** al abrir. Son independientes a propósito, porque los tipos
  no son un único deseo: quien tiene columnas con JSON quiere verlas
  desplegadas sin que le reformateen también el XML. Planteado por David.

  El botón **Format** llevaba ahí desde siempre, y la app siempre ha sabido qué
  tipo de contenido tiene una celda (`detectLanguage`) — lo que faltaba era una
  forma de decir "hazlo ya". La app además se contradecía a sí misma: el panel
  de vista previa, que es de solo lectura, formateaba *sin preguntar*, así que
  veías el valor formateado, abrías el editor sobre él y salía en crudo. Las
  tres superficies —vista previa, editor modal y panel lateral— leen ahora los
  mismos tres interruptores.

  Cuatro decisiones merecen explicación:

  - **El camino automático rechaza cualquier reformateo que haya cambiado algo
    más que espacios en blanco, y esa es la razón de que esto no sean tres
    líneas.** Formatear JSON significa `JSON.parse` + `JSON.stringify`, que es
    una ida y vuelta del *valor*, no de los espacios: `10000000000000000001`
    vuelve como `…000`, `1.0` se convierte en `1`, las claves duplicadas se
    colapsan, las claves con aspecto de entero se reordenan al principio y
    `\u0041` pasa a `A`. Eso siempre ha sido así detrás del botón Format, donde
    el clic es el usuario aceptando la reescritura. Al abrir sería otra cosa,
    porque el texto formateado pasa a ser el punto de partida para guardar:
    "abre la fila con el id de Snowflake, pulsa Ctrl+S y escribe en silencio un
    número distinto". Así que el camino automático formatea, comprueba que solo
    se movieron espacios fuera de literales entrecomillados y de CDATA, y
    descarta su propio resultado cuando no fue así. El botón manual se queda
    deliberadamente sin esa comprobación.
  - **El texto formateado es el nuevo punto de partida, no una edición.** Abrir
    una celda no la marca como modificada y cerrarla no avisa de nada; una
    sesión aparcada que se restaura tras cambiar de pestaña nunca se vuelve a
    formatear, ni tampoco el buffer que entrega "mover al panel lateral" —
    `formatXml` no es idempotente, así que una segunda pasada desviaría la
    indentación que acaba de aplicar.
  - **JSON y XML vienen activados; SQL, desactivado.** Los dos primeros son lo
    que mantiene el panel de vista previa haciendo lo que siempre ha hecho:
    enviarlos apagados se lo habría quitado a todas las instalaciones
    existentes en vez de ser un valor por defecto neutro. SQL es la capacidad
    nueva, y su formateador reescribe la sentencia —mayúsculas de las palabras
    clave—, así que no puede superar la comprobación a la que sí se someten los
    otros dos, y se ofrece como una activación explícita.
  - **El formateo de SQL sigue el dialecto de la conexión**, mediante la nueva
    dependencia `sql-formatter` (MIT): PostgreSQL, MySQL, SQLite y T-SQL para
    SQL Server, y SQL estándar donde no hay conexión a la que preguntar. Solo
    se importan esos cinco dialectos por su nombre en vez de la veintena que
    trae el paquete, así que el bundle crece ~109 KB en crudo / ~30 KB
    comprimido en lugar de arrastrar también BigQuery y Snowflake.

- **"Desplegar todos los objetos" — un gesto por documento y otro para toda la
  página.** Cada tarjeta de la vista de lista lleva ahora un chevron junto al
  contador de campos que despliega (o pliega) todos los objetos anidados de ese
  documento a la vez, a cualquier profundidad; el pie de la tabla lleva el mismo
  par para todos los documentos de la página, junto a los controles de ajuste de
  columnas y zoom de fila que ya responden a "cómo estoy mirando esto".

  Los chevrons por línea solo movían un nivel. Un documento cuyos valores
  interesantes están dos o tres niveles abajo — un `processInfo` indexado por id
  de dispositivo, cada entrada un objeto propio — costaba un clic por nivel para
  leerlo, y luego los mismos clics otra vez en el documento siguiente. Leer una
  página entera así no era algo que se pudiera hacer en la práctica.

  Tres decisiones merecen contarse:

  - **Invierte la base contra la que se miden los pliegues, en vez de conmutar
    un conjunto de rutas.** Un contenedor escondido dentro de un ancestro
    plegado no aporta ninguna línea, así que su ruta no está en la lista de
    campos aplanada y no hay nada que conmutar — un "desplegar todo" basado en
    conjuntos habría abierto exactamente un nivel y ahí se habría quedado.
    Invertir la base abre el árbol entero de una vez y no cuesta nada por nivel.
  - **La pulsación global es un epoch, no un booleano.** Es una acción, no un
    estado: después de pulsarla puedes plegar un objeto a mano, y volver a
    pulsarla tiene que desplegarlo otra vez. Un prop booleano ya valdría `true`
    en la segunda pulsación y no pasaría nada. Además es lo que permite que una
    tarjeta que entra en la ventana del virtualizador *después* de la pulsación
    se monte ya desplegada.
  - **Ninguno de los dos controles toca la preferencia *Desplegar los valores
    anidados por defecto*.** Esa responde a "cómo debe abrirse un documento";
    estos responden a "enséñame todo lo que hay en lo que estoy mirando ahora".
    Mezclarlas haría que un gesto puntual reescribiera un ajuste persistido.

  El control por documento se oculta en un documento que no tiene nada que
  desplegar, y su sentido sigue a lo que hay en pantalla: solo dice "plegar"
  cuando todos los contenedores visibles están abiertos. La **previsualización
  de agregación** lleva también el par, flotando sobre los documentos en vez de
  en una barra propia: esa superficie es además el panel derecho de una tarjeta
  de etapa, donde una franja permanente costaría justo las filas de preview que
  justifican el panel. Mantiene su propia señal, al no tener un grid alrededor,
  y oculta el control cuando el pipeline solo proyecta escalares.

- **"Pegar filas como JSON…" — inserción masiva de filas en los cuatro drivers
  SQL.** Detrás del botón Insertar del grid, junto a la fila-borrador en línea.
  Un objeto JSON es una fila; pega un array y se convierte en un único `INSERT`
  multi-fila dentro de una única transacción. Esto cierra el punto abierto más
  antiguo de `ROADMAP.md`: el borrado masivo llegó en la 1.0.2, y MongoDB está
  cubierto desde que su diálogo de documentos acepta arrays, pero en SQL "aquí
  tienes cuarenta filas" no tenía otra salida que escribir la sentencia a mano
  en el editor de queries.

  El diálogo de MongoDB del que esto toma la forma existe por una razón que no
  se traslada — una colección no tiene esquema, así que un campo que la muestra
  del grid no vio no se podía teclear en absoluto — y el propio docstring de
  `insert_documents` lo dice. Ese argumento va de *forma*, y sigue siendo
  cierto. Lo que le faltaba a SQL es el **volumen**, que es otra cosa.

  Cuatro decisiones merecen contarse, porque cada una tenía una alternativa de
  apariencia razonable:

  - **Una clave pegada no es un nombre de columna hasta que lo dice el
    catálogo.** Las claves se casan contra las columnas reales de la tabla y lo
    que llega al SQL es la grafía del *catálogo*, así que nada tecleado por el
    usuario se entrecomilla nunca como identificador. Una clave desconocida se
    rechaza por su nombre, listando las columnas reales. El casado ignora
    mayúsculas, así que un pegado de una herramienta que las pone en alta
    funciona sin más.
  - **Una fila cuyo juego de columnas difiere de la primera se rechaza**,
    nombrando la fila y las dos caras de la diferencia. Unir las columnas y
    ligar `NULL` en los huecos parece más amable y es incorrecto: pisa el
    `DEFAULT` de la columna, lo que en una `NOT NULL DEFAULT now()` convierte un
    insert válido en una violación de restricción. Agrupar las filas por su
    firma de claves es defendible, y aun así no se eligió de entrada: la causa
    habitual de un juego de claves distinto es una errata en un nombre, y
    agrupar convierte esa errata en una columna que toma su valor por defecto
    sin decir nada.
  - **Un `true` de JSON se guarda como `1` en una columna booleana y como la
    palabra en una de texto.** Esa decisión mira el tipo de la columna y no el
    driver, lo que suena al revés hasta que se ve que `1`/`0` lo aceptan los
    cuatro motores en sus entradas booleanas — el caso que una regla por driver
    no habría podido resolver es el de la columna de texto.
  - **Un pegado demasiado ancho para el tope de parámetros del motor se trocea,
    y los trozos comparten una transacción.** 500 filas × 20 columnas son cinco
    sentencias en SQL Server (que se niega pasados los 2100 parámetros) y una en
    los demás, y en cualquier caso entra el pegado entero o no entra nada. La
    Consola muestra una sola entrada, porque una transacción es una unidad de
    trabajo.

  Las columnas omitidas toman su valor por defecto en la base de datos y `null`
  escribe un `NULL` de SQL, igual que ha hecho siempre el insert de una fila. El
  resultado informa de cuántas filas entraron, no de los ids generados: los
  cuatro motores no se ponen de acuerdo ni en qué son los ids de un insert
  multi-fila — MySQL informa solo del primero, SQL Server solo del último — y un
  recuento es la única respuesta honesta.

  No se expone por MCP. El conector ya tiene un `insert_row` estructurado que le
  sirve mejor a un modelo que un blob de texto, y cada herramienta de escritura
  nueva cuesta tres pasos de cableado que el compilador no comprueba. Ver
  [`engineering/adr/adr-084`](engineering/adr/adr-084-json-row-insert-catalogue-gated-and-transactional.md).

- **"Consultar esta tabla…" sobre una tabla o vista del árbol de esquema.**
  Abre un editor de query ya acotado a la conexión *y* la base de datos de esa
  relación, sembrado con `SELECT * FROM <tabla> LIMIT 100;`.

  La entrada existía uno y dos niveles más arriba — el nodo de base de datos y
  el de esquema tienen "Nueva query aquí" desde hace tiempo — y se paraba justo
  en el nivel donde la gente hace clic derecho de verdad, que es la tabla que
  está mirando. Sacar una consulta sobre una tabla concreta obligaba a abrir un
  editor en blanco y reescribir un nombre que el árbol ya tenía delante.

  Dos detalles son la razón de que esto no sea simplemente
  `openQueryTab(connectionId)`:

  - Pasa `resolveTarget: false`. En una conexión a servidor completo el
    `connectionId` de la fila ya es el hijo `<padre>::db::<db>` con el que se
    montó ese subárbol, y el valor por defecto se lo daría a `queryTargetFor`,
    que reapunta la pestaña a la base de datos en la que esté la pestaña
    *enfocada*. "Consultar esta tabla" significa la base de datos de esta tabla.
  - Va por el bundle de acciones del explorador en vez de importar
    `openQueryTab` directamente, así que dispara el mismo `onTableOpen` que
    dispara abrir una pestaña de datos y el acento de base de datos del árbol
    multi-DB se mueve con ella.

  `selectSnippet` ha ganado un límite de filas opcional para la semilla, lo que
  además cierra una asimetría que arrastraba desde que se escribió: la rama de
  MongoDB siempre emitía `.limit(100)` y la de SQL no emitía cota ninguna. Era
  defendible mientras el único consumidor era "Copiar sentencia SELECT", donde
  el usuario lee el texto antes de ejecutarlo — no lo es para un texto que la
  app te pone en un editor para que lo ejecutes. SQL Server recibe
  `SELECT TOP 100 *`, porque T-SQL no tiene `LIMIT` y la forma
  `OFFSET … FETCH NEXT` que usa la ruta de paginación ejecutada exige además un
  `ORDER BY` que aquí no hay de dónde sacar. "Copiar sentencia SELECT" no
  cambia: sigue copiando la sentencia pelada, porque un fragmento que pegas y
  retocas no quiere que le adivinen una cota.

### Cambiado

- **"Copiar fila como ▸ SQL INSERT/UPDATE" del grid y "Copiar sentencia
  SELECT" / "Consultar esta tabla…" del árbol de esquema ya no cualifican la
  referencia a la tabla con su schema o base de datos.** Antes emitían
  `"schema"."tabla"` (o `` `bd`.`tabla` `` en MySQL); ahora es solo `"tabla"`.
  Esa cualificación tenía sentido antes de que el editor de queries tuviera su
  propio desplegable de conexión/base de datos — un snippet pegado necesitaba
  decir a dónde pertenecía, porque nada más lo decía. Ahora el editor ya
  muestra y controla contra qué base de datos corre la query, así que el
  prefijo en cada copia-pega era ruido redundante que había que leer y
  descartar en cada pegado. Detectado por David.

- **La sincronización en segundo plano de un origen compartido ya no muestra
  el aviso "N conexiones actualizadas desde un origen compartido" cada vez que
  recoge un cambio.** El sondeo corre cada pocos minutos y al arrancar, así
  que en una máquina que sigue un fichero compartido editado activamente el
  aviso saltaba constantemente por cambios que nadie hizo desde esta máquina —
  ruido indistinguible de algo que mereciera la pena leer. Los avisos de
  conexiones desaparecidas o de contraseña sustituida que esta misma
  sincronización también lanza no se han tocado: esos sí nombran algo que el
  usuario tiene que decidir (conservar, borrar, o notar que le cambiaron una
  contraseña sin avisar).

### Corregido

- **El nodo de una base de datos MongoDB ofrecía "Nueva tabla".**
  `DatabaseNodeMenu` — el menú contextual que lleva un nodo de base de datos
  tanto en el explorador de una sola BD como en el multi-BD — mostraba
  "Nueva tabla" sin ninguna condición, justo al lado de "Nueva vista" y
  "Nueva colección", que sí están filtradas por driver. El resto de acciones
  de DDL en ese menú ya comprueban `supportsDdlEditing(driver)`, que es
  `false` para MongoDB precisamente porque no tiene `CREATE TABLE` que
  construir; a "Nueva tabla" simplemente le faltaba la misma comprobación,
  así que una base de datos MongoDB mostraba "Nueva tabla" y "Nueva
  colección" una al lado de la otra, y elegir la primera abría una pestaña
  del editor de estructura que el driver no puede ejecutar. Ahora se filtra
  igual que su vecina.
- **Una colección de MongoDB vacía no tenía forma de insertar su primer
  documento.** La opción de insertar de la rejilla exige una clave primaria
  utilizable (`hasPk` en `TableDataTab`), y en MongoDB esa clave es el campo
  `_id` de la colección — descubierto, como cualquier otro campo, muestreando
  documentos (`infer_columns`). Una colección con cero documentos muestrea
  cero campos, así que `_id` nunca aparecía y la rejilla concluía que la
  colección no tenía clave primaria, ocultando Insertar junto con el resto de
  acciones que dependen de ella. Es la misma clase de fallo que la 1.16.2
  arregló para los drivers SQL (#27) — una relación vacía que no reporta
  columnas — pero el arreglo de entonces (`fetch_table_data` recurriendo a la
  definición del catálogo) no vale aquí, porque MongoDB no tiene catálogo al
  que recurrir: la forma de una colección *es* lo que contienen sus
  documentos. `infer_columns` ahora siembra `_id` a mano cuando el muestreo
  vuelve vacío, ya que todo documento de MongoDB tiene uno exista o no
  todavía ninguno que lo demuestre.
- **Con dos conexiones vivas, el botón "+" abría la pestaña de query contra la
  que no era.** La app tenía dos punteros de "actual" independientes y nada los
  unía: `useUi.selectedConnectionId` — a qué apunta el workspace, y de donde
  sacan su destino el `+` de la barra de pestañas, el atajo `newQuery` y la
  entrada de nueva query de la paleta — y `useTabs.activeId`, la pestaña
  enfocada, que lleva su propio `connectionId`.

  El primero solo lo escribían los flujos de *conexión*: conectar, reconectar,
  el selector de la barra de estado, el selector de workspace y la restauración
  de entorno. Abrir una pestaña escribía solo el segundo. Así que con una
  conexión MySQL y otra MongoDB vivas a la vez, clicar una tabla de MySQL en el
  árbol y pulsar `+` abría el editor contra MongoDB: el árbol no tocaba la
  selección en absoluto, así que se quedaba donde la hubiera dejado la última
  *conexión*. `queryTargetFor` no podía arreglarlo por diseño: solo afina
  *dentro* de la conexión que le pasan (padre → su hijo `::db::`) y descarta
  deliberadamente una pestaña enfocada que sea de otra.

  Clicar una **pestaña ya abierta** de la otra conexión acababa exactamente
  igual. Esa mitad no se reportó nunca, porque es en el árbol donde se nota —
  pero es la misma regla que faltaba, y es la razón de que el arreglo no sea
  una tercera llamada a `setSelectedConnectionId` en el árbol. La paleta de
  comandos y el conmutador de Ctrl+Tab ya llevaban una cada uno, escrita a
  mano, que es la forma que tiene una regla de pedir vivir en un solo sitio. El
  foco ahora *es* la conexión de la pestaña enfocada, derivado una vez en
  `src/stores/session/focusFollowsTab.ts`, y las cuatro llamadas ad-hoc que lo
  aproximaban han desaparecido.

  En consecuencia el workspace sigue a la pestaña en todo lo que ya leía ese
  valor: el título de la ventana del sistema, el objetivo del panel de Pulse, el
  panel de IA, el panel de Consultas guardadas y el subrayado del propio árbol.
  El estado de arranque persistido también: ahora restaura la conexión de la
  última pestaña enfocada en vez de la última conectada, que es la misma
  respuesta en toda sesión que terminó con una pestaña abierta y una mejor en
  las que no.

  Hay dos restricciones que cargan con el peso y están escritas junto al
  código. El id de la pestaña se pasa por `parentConnectionId` antes de
  guardarse, porque `selectedConnectionId` tiene que nombrar un perfil real:
  `useConnections.active` solo contiene ids de primer nivel, y una selección
  `<padre>::db::<db>` se limpia un render después y se sustituye por un pool
  arbitrario. Y la suscripción cuelga del store, no del
  `onDidActivePanelChange` de dockview, que ya desemboca en `useTabs.setActive`;
  una segunda vía dockview↔store es justo lo que la gotcha #010 prohíbe.

- **Las opciones "Copiar fila como ▸ INSERT/UPDATE" y "Copiar con columna" del
  grid se comían las barras invertidas en MySQL.** `sqlLiteral`
  (`src/lib/grid/copyFormats.ts`) entrecomillaba un valor de cadena doblando
  las `'` incrustadas, pero nunca tocaba `\`. Eso es correcto para Postgres,
  SQLite y SQL Server, ninguno de los cuales le da significado especial a `\`
  dentro de un literal entrecomillado normal — pero MySQL sí, por defecto
  (`NO_BACKSLASH_ESCAPES` está desactivado salvo que el servidor lo active):
  un valor como `DOMINIO\usuario` se copiaba como `'DOMINIO\usuario'`, y al
  pegarlo y ejecutarlo contra MySQL, `\u` se interpretaba como la secuencia
  de escape de una `u` literal, así que la fila volvía como `DOMINIOusuario`.
  La ruta de volcado del backend (`src-tauri/src/db/dump.rs`) ya escapaba
  `\` → `\\` exactamente por este motivo; este generador de portapapeles,
  construido de forma independiente en el frontend, no lo hacía.
  `sqlLiteral` ahora recibe el driver y escapa `\` primero (antes de doblar
  `'`) cuando es `mysql`, igual que la ruta de volcado; los otros tres
  drivers quedan intactos por construcción, y `toSqlInsert`/`toSqlUpdate`/el
  "Copiar con columna" de `GridRow` propagan el driver hasta el fondo.

- **Cambiar de entorno bloqueaba la app lo que tardaban en cerrarse las
  conexiones salientes más lo que tardaban en abrirse las entrantes — el
  handshake más pesado de MongoDB hacía que pareciera un cuelgue.**
  `useEnvironments.switchTo` cierra todos los pools que el entorno saliente
  tenía abiertos antes de entregarle el backend al entrante, y ese orden es
  estructural (ver la gotcha #027 y el comentario del comando `disconnect`:
  reconectar antes de que los pools salientes estén realmente cerrados puede
  duplicar brevemente el presupuesto de conexiones contra el mismo
  servidor). Un primer cambio hizo concurrente el propio cierre saliente en
  vez de uno a uno, lo que ayudaba pero dejaba intactos los dos costes
  reales: `switchTo` seguía esperando toda la secuencia
  cierre-luego-reconexión antes de que `EnvironmentSwitchGuard` retirase su
  overlay inerte del árbol de esquema y del área de pestañas, así que un
  entorno con una conexión MongoDB lenta en cualquiera de los dos lados del
  cambio se quedaba sellado durante todo ese tiempo.

  La solución quita la espera en vez de acortarla: `switchTo` ahora le
  entrega el backend al entorno entrante — activando su puntero, aplicando
  su tema/filtros/pestañas — *antes* de pedirle a un solo pool saliente que
  se cierre, en vez de después de que todos estén confirmados como
  cerrados. El árbol del entorno saliente deja de estar en pantalla antes
  de que arranque ningún cierre de red real, que es justo lo que permitió
  eliminar `EnvironmentSwitchGuard` por completo: la condición de carrera
  que existía para evitar (un click reabriendo un pool a medio cerrar)
  necesita que el árbol saliente siga renderizado, y ya no lo está. La
  secuencia cierre-luego-reconexión en sí no cambia de forma (los pools
  salientes se cierran de forma concurrente, reutilizando el mismo
  `disconnectAndClean` que usa `disconnectAll`; solo cuando todos están
  confirmados como cerrados se abren los entrantes, respetando el mismo
  orden por el presupuesto de conexiones de antes) — simplemente corre ya
  con el usuario mirando, y pudiendo trabajar ya, en el entorno destino, con
  cada una de sus conexiones mostrando su propio estado "conectando…"
  (`useConnections.connecting`, compartido con un click manual para que
  nunca puedan pisarse entre sí) hasta que termina de abrirse.

  Acertar con el reordenado dependió de un hecho verificado directamente
  contra el backend: `save_launch_state`/`get_launch_state`/`save_tab_state`
  siempre resuelven contra *el entorno que esté activo en ese momento*, sin
  recibir ningún id de entorno explícito. Así que el guardado definitivo del
  launch state del entorno saliente — antes escrito después de su bucle de
  cierre, como un "gana la última escritura" sobre lo que cada conexión
  escribía por su cuenta durante ese bucle — ahora se escribe (y tiene que
  escribirse) *antes* del traspaso, con los mismos valores ya capturados al
  principio de la función; las llamadas a `disconnectAndClean` que siguen al
  traspaso pasan `persistLaunch: false` para que ya no puedan pisar ese
  guardado escribiendo contra el entorno equivocado (el entrante, ahora
  activo).

## [1.24.0] — 2026-09-14

### Añadido

- **Cada equipo elige qué se trae de un origen compartido.** Un fichero
  publicado lleva tres cosas independientes — las conexiones, los entornos que
  las agrupan y la biblioteca de esquemas JSON con sus vínculos a columnas — y
  Ajustes → Orígenes permite ahora suscribirse a cada una por separado, por
  origen, al registrarlo y después desde «Editar registro».

  Esta es la respuesta a un reparto que aparece en todos los equipos que usan
  orígenes: hay quien quiere que le den la configuración entera y quien ya tiene
  sus entornos montados a su gusto y solo quiere los servidores. Hasta ahora la
  única forma de servir a ambos era que quien mantiene el fichero publicase un
  *segundo* fichero solo con conexiones — que nada mantenía al día respecto al
  primero, así que los dos acababan divergiendo. Ahora ambos grupos registran el
  mismo fichero y marcan casillas distintas, lo que hace esa divergencia
  imposible en lugar de simplemente desaconsejada: hay un solo documento, y
  quien publica publica siempre el superconjunto.

  Partir el propio documento se valoró y se descartó. Habría mantenido los dos
  ficheros y habría añadido una referencia cruzada que se puede romper, un
  segundo dominio de concurrencia sin transacción sobre el par, y una pregunta
  de propiedad que `ConnectionProfile.origin_id` — un solo campo, y todo el
  modelo de propiedad — no puede responder.

  El formulario muestra lo que lleva el fichero antes de elegir, así que
  suscribirse a «entornos» no es adivinar si publica alguno; un bundle de
  conexiones normal solo ofrece la primera casilla, porque es lo único que puede
  aportar. Hay dos combinaciones que se permiten y se explican en vez de
  prohibirse, porque cada una es correcta para alguien: los entornos sin sus
  conexiones se replican vacíos, y los esquemas JSON sin sus conexiones llegan
  con todos sus vínculos desactivados.

  **Desmarcar una casilla no borra nada.** Lo que una suscripción más amplia ya
  trajo sigue vinculado al origen y de solo lectura, y simplemente deja de
  actualizarse. Liberarlo como entradas locales normales sigue siendo un paso
  aparte y deliberado — y sin vuelta atrás, porque una conexión desvinculada es
  tuya a partir de entonces y el origen no la vuelve a adoptar.

  Un origen registrado antes de que esto existiera se sigue trayendo las tres
  cosas, y ese valor por defecto no es una comodidad sino una pieza clave: este
  indicador describe lo que el origen ya hacía, no un permiso, así que un valor
  por defecto cerrado habría estrechado todos los orígenes registrados al
  actualizar y habría hecho que la siguiente sincronización informase de que ha
  desaparecido la configuración entera del usuario. Ver
  [`engineering/adr/adr-083`](engineering/adr/adr-083-origin-consumption-scope-defaults-open.md)
  (en inglés).

### Corregido

- **Las bases de datos de MongoDB se pueden eliminar, y un servidor sin bases de
  datos ya no es un panel vacío.** Dos mitades del mismo error, ambas en la raíz
  de una conexión a nivel de clúster.

  La entrada «Eliminar base de datos…» del árbol dependía de
  `supportsCreateDatabase`, así que MongoDB — que no tiene comando
  `CREATE DATABASE` porque el servidor no guarda bases de datos *vacías* — se
  quedaba también sin poder borrar una llena, aunque `dropDatabase` es un solo
  comando que siempre ha soportado. Un único predicado respondía a dos
  preguntas; ahora son `supportsCreateDatabase` y `supportsDropDatabase`, y la
  rama MongoDB del backend ejecuta el borrado en lugar de devolver «no está
  soportado aquí». Antes comprueba que la base existe: `dropDatabase` contra un
  nombre inexistente responde éxito, lo que habría confirmado una errata al
  usuario como si fuera un borrado.

  Eliminar una base de datos, además, ha dejado de leer la preferencia
  `ui.confirmDestructive`. Desactivarla es razonable cuando el aviso va de
  borrar una fila que puedes volver a insertar; nunca quiso decir «tira una base
  de datos entera con un clic de menú y sin nada por medio», y
  `confirmIrreversible` — que existe justo para esto y que `DROP TABLE` ya
  usaba — es lo que debería haber estado llamando.

- **Crear una base de datos funciona en MongoDB, que es lo que le faltaba al
  árbol vacío.** Como en el servidor no existe la base de datos vacía, «Nueva
  base de datos» pide ahí también la primera colección y crea ambas, el mismo
  par que pide Compass. `create_database` recibe un `initial_collection`
  opcional en vez de partirse en dos comandos — la intención es una sola, y
  partirlo habría llevado la bifurcación por driver al frontend — y los drivers
  SQL lo rechazan en lugar de ignorarlo.

- **Una conexión single-DB tiene nodo de base de datos, y ahí es donde viven
  las acciones de la base.** La otra mitad de la misma asimetría, y la que de
  verdad se tocaba a diario: un perfil con `database` fijada no mostraba ningún
  nodo de base de datos — su nodo superior es un *esquema* —, así que «Eliminar
  base de datos…», que vive en un nodo de base de datos, no existía en ninguna
  parte, mientras que «Nueva base de datos» sí estaba en el menú de la
  conexión. Podías crear una base desde una conexión y luego no tener forma de
  borrarla desde ningún sitio de la app.

  El arreglo es el nodo, no una entrada más en la conexión: quien quiere borrar
  una base de datos va a la base de datos. Lo que eso significa en cada motor
  es la parte que merece decirse, porque el nodo superior del árbol solo *a
  veces* es la base. MySQL y MongoDB reportan un único esquema con el nombre de
  la propia base, así que los dos se funden en un solo nodo — sin nivel de más
  ni nada anidado dentro de sí mismo — y ese nodo lleva el menú de base de
  datos. Postgres y SQL Server reportan `public`/`dbo` dentro de una base que
  el árbol nunca había dibujado, así que el nodo de base aparece por encima,
  que es su sitio. SQLite no recibe ninguno: su fichero *es* la base.

  Los dos modos renderizan ahora el mismo menú desde el mismo componente
  (`DatabaseNodeMenu`), incluida «Nueva colección», que estaba en la conexión
  por la misma razón de no-había-otro-sitio. Los dos modos se diferencian solo
  en lo que tienen que resolver antes — multi-DB abre un pool sintético por
  base, single-DB ya está ligada — y en las consecuencias de un borrado, que
  es por lo que eso siguió siendo una prop.

  **Los cuatro motores no se ponen de acuerdo sobre borrar la base a la que
  estás conectado, y se tratan los cuatro en vez de dejar tres fallando.**
  MySQL y MongoDB simplemente lo permiten. PostgreSQL lo rechaza siempre — una
  sesión no puede borrar su propia base, y el servidor rechaza también mientras
  haya *cualquier* sesión conectada, así que emitir la sentencia desde otro
  sitio no basta por sí solo: primero se cierra el pool y la sentencia viaja por
  una conexión efímera a la base de mantenimiento `postgres`, construida
  clonando las `PgConnectOptions` del propio pool (mismo host y puerto,
  incluido el listener local del túnel SSH, mismas credenciales y mismo modo
  TLS, y sin una segunda visita al llavero). SQL Server lo rechaza mientras la
  base esté en uso, y para eso bastan las propias sesiones ociosas del pool:
  la sesión en uso se muda a `master` y el resto se cierran, mediante un nuevo
  `MsSqlPool::close_idle` que deja el pool en condiciones de reabrir — porque
  un borrado rechazado no debe dejar además una conexión muerta.

  La conexión se cierra después tanto si el borrado ha funcionado como si no:
  a esas alturas su pool está cerrado o su base por defecto ha desaparecido de
  todos modos, y dejarla marcada como activa haría que cualquier comando
  posterior fallara con algo mucho menos legible que el error que el usuario
  acaba de leer. El perfil guardado no se toca a propósito — apunta a una base
  que ya no existe, cosa que el aviso dice claramente, y borrar configuración
  guardada y una entrada del llavero es una decisión mayor que la que el
  usuario ha tomado.

- **Una conexión cuyo servidor no tiene bases de datos ahora lo dice.** No
  pintaba literalmente nada: ni fila, ni frase, lo que se lee como una conexión
  que ha fallado y no como un servidor vacío, y dejaba la creación de la primera
  base como algo que el usuario tenía que saber de antemano que estaba escondido
  en el menú contextual de la conexión. El árbol distingue ahora los dos motivos
  por los que puede estar vacío — un servidor sin bases de datos, que ofrece
  «Nueva base de datos», y todas las bases ocultas por el subconjunto visible,
  que ofrece el selector.

### Cambiado

- **Las filas del árbol de esquema son ahora un único primitivo.** Cuatro
  sitios habían escrito a mano el mismo `<button>`: ancho completo, el mismo
  padding, el mismo `hover:bg-accent` y el mismo anillo de foco gobernado por
  «¿está mi menú contextual abierto sobre mí?». `ui/tree-row.tsx` se queda con
  ese envoltorio y cada fila conserva su contenido, que es la parte que de
  verdad cambia. Dos entradas salen del presupuesto de botones crudos de
  `uiAdoption.test.ts` (136 → 134).

- `commands::schema::create_collection` valida a través del mismo
  `validate_collection` que ya usaban el resto de escrituras a nivel de
  colección de MongoDB, en vez de su propia copia en línea de dos de sus tres
  comprobaciones. El validador compartido ha ganado además la comprobación de
  `$`/NUL, que no tenía ninguno de los dos.

## [1.23.0] — 2026-09-11

### Añadido

- **Un panel de resultados por cada sentencia que devuelve filas, en vez de
  solo la última.** Ejecutar un script con varios `SELECT` (o varios `.find` /
  `.aggregate` en MongoDB) mostraba exactamente un grid: el backend construía
  un conjunto de resultados completo para cada uno y cada uno sobrescribía al
  anterior en un único campo `last_result`. Ahora cada sentencia lleva el suyo,
  y una tira encima del grid elige cuál se ve — `#1 · 120 filas`,
  `#2 · 8 filas` — mientras que las sentencias que no devuelven nada siguen
  reportándose en la línea de resumen del lote, que es donde corresponden el
  recuento de filas afectadas de una escritura y la sentencia que detuvo el
  lote. Una ejecución que falla a mitad conserva todos los paneles que produjo
  antes del fallo.

  **SQL Server gana los conjuntos de resultados que ya traía y tiraba.** Una
  sola sentencia T-SQL puede devolver varios legítimamente, y el ejecutor de
  lotes se quedaba con el primero no vacío — algo razonable cuando solo había
  un grid donde ponerlo, y una pérdida silenciosa en cuanto hay un panel por
  resultado. Por eso los resultados de una sentencia son una lista y no un
  resultado único, etiquetados `#2.1` / `#2.2` cuando hay más de uno.

  **El tope de filas pasa a ser un presupuesto compartido por todo el lote.**
  `MAX_ADHOC_QUERY_ROWS` (50 000) acota una sentencia, que era toda la historia
  mientras un lote devolvía un único conjunto de resultados; conservar el de
  cada sentencia habría convertido un script de diez `SELECT` en diez veces ese
  techo, por IPC y en el DOM — justo el desbordamiento de memoria que el tope
  existe para evitar. Un lote conserva ahora las mismas 50 000 filas que puede
  conservar una sentencia, repartidas en orden de sentencia: la que se topa con
  lo que queda conserva las filas que caben y se marca como truncada, con la
  misma bandera y el mismo texto que al superar el tope por sentencia. Su
  recuento de filas no se toca: descartar filas del grid no puede hacer que el
  resumen diga que un `SELECT` no devolvió nada.

  Solo se monta el grid del panel seleccionado. Es una decisión deliberada y no
  una optimización pendiente: `gridSelection` se indexa por id de pestaña y el
  editor de celda acoplado toma ese mismo id como dueño, así que dos grids
  vivos en una pestaña se pisarían el recuento de selección y se pelearían por
  el editor.

  `BatchResult.last_result` desaparece. Con un conjunto de resultados en cada
  sentencia era una segunda copia completa del mayor payload del lote cruzando
  el borde IPC para un consumidor que ya no existe — el diálogo de importar SQL
  y la ruta de escritura de MCP solo leen `statements` y `total_affected`.

- **Dos tokens de tema que el rediseño de los diálogos necesita, adelantados.**
  `--scrim` es el velo que se pinta entre la app y un diálogo abierto. Era
  `bg-black/60` — un negro *literal*, escrito a mano en los dos únicos sitios
  donde se construye la pila modal (`ui/dialog.tsx`,
  `shell/OverlayPalette.tsx`) — y por tanto el único punto donde esa pila se
  escapaba por completo del sistema de temas: un tema claro recibía un apagón en
  vez de una atenuación, y los presets cálidos uno frío. Cada uno de los diez
  bloques de color integrados declara ahora el neutro más oscuro que ya tiene
  (su propio `background` si la superficie es oscura, su `foreground` si es
  clara). Se deja fuera de `COLOR_KEYS` a propósito, como `pk`/`fk`/`numeric`:
  es una superficie del sistema, no un color que nadie deba editar en
  Apariencia. El alfa **no** está en el token — `applyTheme` pasa todos los
  valores por `hexToHslColor`, así que un `rgba()` no sobreviviría —, vive en la
  utilidad y cambia según el modo, porque un solo alfa no puede a la vez atenuar
  una página blanca y oscurecer una ya oscura.

  `shadow-island` es la elevación de la isla del workspace, promovida desde la
  cadena escrita a mano que vivía dentro de `IslandShell.tsx` (que pasa a ser su
  primer consumidor en lugar de su dueño). Es deliberadamente más plana que
  `elevation-3` y mucho más ligera que `elevation-4`, porque una isla se apoya
  *sobre* la trinchera en vez de flotar sobre ella — que es justo lo que un
  diálogo a pantalla completa tendrá que tomar prestado para leerse como esa
  isla levantada, y no como una tarjeta ajena puesta encima.

  Todavía no cambia nada visualmente: esta es la capa de tokens del rediseño de
  diálogos y chips de pestaña, separada para que el cambio que los gasta se
  pueda revisar por su cuenta.

### Cambiado

- **Los diálogos tienen ahora tres anatomías (`prompt`/`panel`/`workbench`) en
  vez de una, y la tira de pestañas está acoplada a su panel en vez de flotar
  como una fila de chips sobre una trinchera.** `DialogContent` elige un
  `tier`, y `DialogHeader`/`DialogBody` (nuevo)/`DialogFooter` lo leen de un
  contexto privado — un sitio de llamada dice una palabra y ya no puede volver
  a declarar el riel de la cabecera, el padding del cuerpo, el radio ni el
  hueco del botón de cerrar, que es justo lo que siete rieles copiados a mano
  (en cinco ortografías distintas) invitaban a hacer. `prompt` (8 px, el radio
  del propio chip de pestaña) son los ~11 confirms de una línea; `panel`
  (10 px, el radio de la isla, y el que se usa por defecto) son los ~18
  formularios; `workbench` (a sangre, tomando prestado el borde/relleno/
  `shadow-island` de la isla del workspace) es Ajustes, el gestor de
  conexiones, el editor de orígenes compartidos, Documentación, y el modo a
  pantalla completa del editor de celda. `DialogActions` pierde su prop `size`
  (los botones son siempre `sm` ahora, zanjando una divergencia que la mitad de
  los pies de la app ya había resuelto en un sentido y la otra mitad en el
  otro) y Cancelar converge en un botón `ghost` en todos los sitios.

  El chip activo de la tira de pestañas ahora se funde con el panel de abajo:
  radio sólo en las esquinas de arriba, su costura inferior se pinta encima en
  vez de que la línea de la tira la corte, los chips inactivos pierden su
  relleno, y desaparece el `drop-shadow` que los levantaba — una pestaña
  acoplada no flota además sobre la superficie a la que pertenece. La propia
  tira baja de 42 a 38 px. Los colores por pestaña y los tres estilos de
  acento de `Preferencias → General` (cap/rail/boxed) no se ven afectados.

  `window.confirm` se retira en favor de un diálogo de confirmación propio de
  la app (`ConfirmHost`) que sigue el tema del resto de la aplicación en vez de
  mostrar el aviso sin estilo del sistema operativo — los diez sitios que antes
  congelaban la ventana con un diálogo nativo (borrar una base de datos,
  importar un `.sql`, reconstruir un índice, el aviso del sidecar de MCP antes
  de instalar una actualización, entre otros) muestran ahora uno con el mismo
  texto y la misma protección de "escribe para confirmar" que tenían antes.

### Corregido

- **El grid de resultados recortaba sus últimas filas, sin forma de llegar a
  ellas.** La raíz de `DataGrid` es `h-full`, así que su altura es el `100%` de
  aquello donde se le meta. El área de resultados de la pestaña de query y la
  vista previa del editor de vistas lo colocaban directamente en una línea flex
  que ya tenía cabecera — el resumen del lote y la tira de pestañas de resultado
  en un caso, el título de la previsualización en el otro —, así que ese `100%`
  se resolvía contra el panel *entero* y el grid colgaba por debajo de su
  contenedor exactamente la altura de sus hermanos. El panel recortaba lo que
  sobresalía, de modo que el scroll del propio grid llegaba a un final que el
  usuario no podía ver: las últimas filas eran inalcanzables y ninguna barra de
  scroll lo decía. Ambos le dan ahora al grid la misma caja
  `flex-1 overflow-hidden` que `TableDataTab` le ha dado siempre. Medido sobre
  el caso reportado, la última fila quedaba 48 px por debajo del borde visible.

  Un contrato de código (`uiContracts.test.ts`, regla K) exige ahora que todo
  punto de uso de `<DataGrid>` viva dentro de una caja así. Esto es puro layout
  — no lo comprueba el compilador y jsdom no puede verlo — y ya se había
  publicado dos veces, incluida la vista previa de vistas, donde era cierto
  desde el día en que se escribió.

- **Un comentario al principio dejaba una sentencia MongoDB inejecutable — y, peor,
  invisible para la protección de escrituras.** `shell::parse` recortaba espacios
  y un `;` final y después exigía que el texto empezara por `db.`; nunca se
  saltaba los comentarios. Así que un `// nota` encima de la sentencia se
  rechazaba con «MongoDB statements must start with `db.`» — el fallo con el que
  una pestaña de query nueva tropezaba por culpa de su propia pista sembrada, y
  con el que sigue tropezando cualquiera que escriba una nota (o pulse Ctrl+/,
  que ahí inserta `//`). Ahora se saltan ambas formas, `//` y `/* … */`, con un
  único helper compartido con `looks_like_mongo` para que los dos no puedan
  discrepar sobre dónde empieza una sentencia.

  Esa parte compartida es la mitad relevante para la seguridad.
  `looks_like_mongo` es lo que enruta una sentencia al clasificador de Mongo en
  `db::classify`, así que un `db.users.deleteMany({})` comentado respondía «no es
  Mongo», caía al clasificador de SQL — que jamás ha oído hablar de `deleteMany`
  — y se colaba por delante de `is_unfiltered_write`, la protección contra el
  borrado de colección entera que el conector MCP rechaza en todos los niveles.
  La sentencia idéntica sin el comentario sí se rechazaba. Ahora se rechazan las
  dos.

- **Una pestaña de query nueva contra MongoDB fallaba en su primera ejecución,
  por culpa de la propia pista que se sembraba.** La pestaña se abría con
  `// db.coleccion.find({}) — pulsa Ctrl+Intro`, y `shell::parse` recorta
  espacios y un `;` final y después exige que la sentencia empiece por `db.` —
  no ignora comentarios. Así que ejecutar el buffer tal y como venía se
  rechazaba con «MongoDB statements must start with `db.`», y borrar la pista
  era lo que hacía funcionar la pestaña. Una pestaña de Mongo se abre ahora
  vacía. La semilla de SQL sigue siendo un comentario `--`, porque todos los
  motores SQL de aquí lo ignoran.

  Esto quita el síntoma, no la asimetría de fondo: una nota `//` escrita a mano
  encima de una sentencia — que es justo lo que Ctrl+/ inserta ahora en esa
  pestaña — sigue fallando igual, y `looks_like_mongo` sigue leyendo un buffer
  así como si no fuera de Mongo. Enseñar a `shell::parse` a saltarse los
  comentarios iniciales es el arreglo de verdad, y queda deliberadamente fuera
  de este cambio.

- **El autocompletado de la pestaña de query en una conexión MongoDB, que era
  el de SQL.** El editor le pedía a Monaco el lenguaje `"sql"` de forma
  literal, sin ninguna rama por driver en todo el archivo salvo la etiqueta de
  la barra de estado — así que una pestaña de Mongo recibía la gramática
  Monarch de SQL, su configuración de comentarios (`--`, que es la razón de que
  una nota `//` se tokenizase como un operador y de que Ctrl+/ insertara un
  `--` que la gramática de Mongo no conoce),
  su splitter por `;` y una lista plana de sugerencias sin caracteres de
  disparo. Escribir `db` abría un widget *vacío*: `"db"` no está en ningún
  catálogo, así que Monaco lo filtraba difusamente contra unos 70 elementos sin
  relación y no casaba ninguno.

  Una conexión MongoDB tiene ahora su propio lenguaje de editor,
  `mongodb-query`, con una gramática que colorea la shell (el handle `db`, las
  llamadas a métodos, los constructores BSON y una cadena prefijada por `$`
  como referencia a un campo en vez de como texto) y un provider de completado
  que entiende la cadena en lugar de ofrecer un listado de palabras: `db.`
  ofrece **colecciones**, `db.<colección>.` los **métodos** que acepta el
  parser del backend — insertados como snippets ejecutables (`find({})`, no un
  `find` pelado) y marcados cuando escriben —, el `.` tras una llamada cerrada
  ofrece exactamente los **cuatro modificadores de cursor** y nada más, y
  dentro de una lista de argumentos ofrece **nombres de campo** más los
  operadores que encajan con la llamada: operadores de consulta en un filtro,
  operadores de actualización en un documento de update, y todo el catálogo de
  etapas/acumuladores/expresiones de agregación dentro de `aggregate([…])`.

  De ahí salen dos cambios de apoyo. El splitter de sentencias ha ganado un
  **dialecto**: con `mongo`, el comentario de línea es `//`, `--` no es un
  comentario, las comillas invertidas no delimitan identificadores y `$` ya no
  abre un cuerpo dollar-quoted de Postgres — antes un par `$gt` … `$lt` parecía
  exactamente eso y se tragaba todos los `;` intermedios, y un `;` dentro de una
  nota `//` partía mal el buffer, con lo que el lens «▶ Run» se
  anclaba en la línea del comentario. Y la pestaña de query calienta ahora el
  esquema por su cuenta (`useEnsureSchemaLoaded`) en vez de depender de que el
  usuario haya expandido antes la conexión en el explorador, así que una
  pestaña recién abierta tiene sus tablas — o sus colecciones — desde el
  principio. Los campos siguen siendo perezosos y se muestrean como mucho una
  vez por colección y sesión.

  El catálogo del que salen las sugerencias es un espejo mantenido a mano de
  `src-tauri/src/db/mongo/shell.rs`, recogido en un solo archivo
  (`lib/mongo/shellCatalog.ts`) y compartido con la lista de constructores del
  editor de agregación, para que los dos no puedan divergir. Nada del frontend
  parsea la sentencia: un escáner de posición de cursor dice dónde está el
  caret, y el único parser sigue estando en Rust.

- **La animación de apertura/cierre de los diálogos, rota en silencio desde que
  se adoptó el `Dialog` por defecto de shadcn.** Cada diálogo se centraba con
  un `transform`, y la animación de fundido/zoom también escribe en
  `transform` durante los 200 ms que dura — uno sustituía al otro, así que en
  la práctica todo diálogo entraba desde la esquina superior izquierda del
  viewport en vez de desde su propio centro. El centrado vive ahora en una capa
  contenedora en vez de en el propio `transform` del diálogo, lo que además
  hace que un diálogo más alto que la pantalla haga scroll en vez de recortarse
  por los dos bordes, y que la paleta de comandos / el selector de pestañas
  gane la animación de salida que nunca tuvo.

## [1.22.0] — 2026-09-10

### Añadido

- **MongoDB: el filtro avanzado ya entra dentro del documento.** Una condición
  solo podía nombrar un campo de primer nivel, mientras la vista de lista dos
  paneles más allá ya renderizaba, tipaba y editaba todos los anidados — así que
  `customData.format` era algo que veías y editabas pero por lo que no podías
  filtrar.

  En una colección de MongoDB el selector de campo es ahora un combobox con
  búsqueda que lista las rutas anidadas encontradas en la página que tienes
  delante, cada una bajo el campo al que pertenece y etiquetada con su tipo
  BSON: elige `stats.count`, o `items.sku` para que coincida *cualquier*
  elemento de un array de subdocumentos. Escribe para filtrar la lista, flechas
  y Enter para elegir y — porque esas rutas son una muestra de la página
  cargada, no un catálogo — puedes escribir directamente una ruta que la lista
  no tenga, para un campo que solo llevan los documentos antiguos. El mismo
  selector sirve a la mitad «coincidencia» de la actualización masiva, así que
  los dos diálogos no pueden discrepar sobre qué es filtrable.

  Todos los operadores funcionan sobre una ruta anidada, los valores se siguen
  convirtiendo al tipo que el campo realmente guarda (un `long` comparado
  contra un `long`, no contra una cadena) y el filtro guardado no cambia de
  forma — un nombre de campo con puntos es una ruta en el momento en que lo ve
  el constructor de consultas de Mongo.

- **El asistente arranca con el mapa, y con lo que tú le cuentes.** Dos
  respuestas a la misma queja: si le das herramientas y nada más, un modelo se
  centra en la tabla que nombró tu pregunta, porque por lo que él sabe no existe
  nada más.

  **Cada turno del agente abre ahora con la lista de tablas**, leída una vez
  antes de la primera llamada al modelo. Solo nombres — ochenta cuestan unos
  cientos de tokens, mientras que ochenta estructuras de tabla llenarían el
  contexto y no dejarían sitio a la pregunta — y con las dos frases que hacen
  que una lista sea algo más que un adorno: que es toda la superficie, y que la
  tabla de al lado puede ser la que la pregunta busca de verdad. La Consola
  muestra cuánto preámbulo salió.

  **Y Ajustes → IA tiene un campo de notas por conexión**: "Lo que el asistente
  debería saber". Es el contexto que ninguna herramienta puede descubrir — que
  `cfg_*` es una fila por tenant, que `status` usa los códigos de un sistema
  antiguo, que la tabla por la que todo el mundo pregunta es la del nombre menos
  obvio. Lo escribes una vez y se envía con cada pregunta sobre esa conexión,
  tanto en turnos de agente como en tareas asistidas, etiquetado como tuyo para
  que el modelo lo pese como conocimiento sobre la base de datos y no como una
  cosa más que ha leído. Dos mil caracteres, recortados avisando a partir de
  ahí. Local a esta máquina y preservado ante una actualización de origen
  compartido, igual que los dos interruptores de encima.

- **Una guía del panel de IA, en la app y en el repositorio.** Ayuda →
  Documentación incorpora una página **Panel de IA** (en inglés y español, como
  el resto de la documentación) que responde a las dos preguntas que la función
  plantea de verdad: dónde corre el modelo y si puede ver filas. Incluye la
  tabla de combinación de esos dos interruptores, qué sale de tu máquina en cada
  configuración, una tabla de hardware para elegir un modelo que quepa en tu
  GPU, el patrón de endpoint compartido para un equipo con una sola máquina con
  GPU, los tres resultados de la comprobación de capacidad y las asperezas
  conocidas — incluida la de que un modelo pequeño a veces escribe un `SELECT` y
  se queda esperándote en lugar de leer la tabla él mismo.

  Termina remitiendo al conector MCP a quien ya paga Claude o ChatGPT: una
  suscripción no está disponible para aplicaciones de terceros, y el conector es
  la vía admitida para aprovechar una licencia que ya tienes.

  `PRIVACY.md` se actualizó en la misma pasada, porque esta función cambia la
  respuesta a la pregunta para la que existe ese documento: el endpoint de
  inferencia que configures se suma a la lista de hosts con los que HuginnDB
  habla, las conversaciones quedan registradas como algo que no vive en ningún
  sitio salvo la memoria, y la clave de API de un proveedor como algo que vive
  en el llavero del sistema y en ningún otro lugar.

- **Modo agente: el asistente se lo busca él solo.** Actívalo en Ajustes → IA y
  el chat normal deja de estar ciego — lista las tablas, describe las que
  necesita y responde con lo que ha leído de verdad, no con lo que ha supuesto.

  **Se niega a funcionar en un modelo que no puede hacerlo.** El modo agente
  está a una medición de distancia, no a una preferencia: la comprobación del
  endpoint tiene que decir que hay herramientas, y si nunca se ha hecho, se hace
  una antes de arrancar el bucle. Un modelo pequeño al que le pides encadenar
  llamadas a herramientas no se degrada con elegancia — se lo inventa, y el
  asistente parece estar funcionando hasta justo el punto en que resulta que
  nada de lo que dice haber leído se leyó nunca. El modo asistido es lo que
  reciben los demás, y para sus cuatro trabajos es *mejor*, porque el contexto
  se eligió a propósito en vez de descubrirse.

  **Cada paso está en la Consola**, con su propio filtro de IA: las herramientas
  que se le ofrecieron y si incluían acceso a filas, cada llamada con sus
  argumentos, y el *número* de filas de cada resultado. El contenido nunca — esos
  son los datos de los que trata la garantía de solo metadatos, y escribirlos en
  un panel del que puedes copiar sería una forma rara de cumplirla. Esta es la
  parte que hace la garantía comprobable en vez de solo enunciada.

  Tres topes duros acotan un turno: seis llamadas al modelo, doce lecturas y el
  límite de filas que ya lleva cada herramienta. Llegar a uno termina el turno y
  lo dice en la respuesta, porque "el modelo se rindió" y "al modelo lo cortaron"
  son hechos distintos y solo uno merece reintentarse. Parar sigue abortando la
  petición y no el pintado — entre dos llamadas a herramienta termina el turno en
  vez de dejar que empiece la siguiente.

  Sigue sin poder escribir. Las herramientas son de solo lectura, ninguna
  escritura está en el catálogo, y un `run_query` que lleve algo que no sea una
  lectura se rechaza con la instrucción de proponer la sentencia en su lugar.

- **El asistente ya puede leer tu base de datos, cuando se lo pides.** Cuatro
  trabajos cuyo contexto monta HuginnDB, cada uno una sola llamada al modelo sin
  bucle de herramientas — que es justo lo que hace que funcionen en un modelo
  demasiado pequeño para confiarle uno.

  Clic derecho sobre una sentencia en el editor para **Explica esta sentencia** o
  **¿Por qué es lenta esta sentencia?** (la segunda le entrega al modelo el plan
  del propio servidor). Clic derecho sobre una tabla en el árbol de esquema para
  **Documentar con IA**: columnas, índices y — solo cuando el endpoint puede leer
  filas — un puñado de valores de muestra. Las filas de sentencias lentas de
  Pulse llevan la misma pregunta, allí donde la sentencia, sus tiempos y su plan
  ya están en pantalla. Y en el compositor del panel, la varita escribe SQL para
  lo que hayas escrito, contra la estructura de las tablas de las que parece
  hablar tu petición.

  El chat normal sigue sin leer nada: no tiene herramientas hasta que llegue el
  bucle de agente, y su prompt lo dice en vez de dejar que el modelo se invente
  un esquema y lo presente como leído. Estos cuatro son los que miran, y cada
  lectura que hacen aparece en la Consola junto a tus propias sentencias — un
  asistente cuyas lecturas se ven es uno al que puedes creer sobre lo que *no*
  ha mirado.

  La regla de filas se mantiene en todo. Documentar es el único trabajo que lee
  filas, y con un endpoint de solo metadatos no se desactiva: quita la muestra y
  el prompt le dice al modelo que no hable de valores que no ha visto.

- **El panel del asistente, en el dock derecho.** Un tercer inquilino junto a
  Consultas guardadas y Pulse, con su propio ancho, su entrada en la barra de
  actividad y una entrada en el menú Ver a la que puedes asignar un atajo.
  Apagado hasta que lo enciendas en Ajustes → IA.

  Lo que hace hoy es conversar y proponer sentencias. La conversación se guarda
  **por conexión** — el asistente habla de una base de datos, y un hilo que te
  siguiera a otro servidor respondería sobre los datos equivocados con total
  seguridad — y llega token a token, con un botón de parar que aborta la
  petición de verdad en vez de limitarse a dejar de pintar.

  El compositor lleva los dos mandos que cambian una respuesta: un selector de
  modelo alimentado por la propia lista `/models` del endpoint, y la pista de
  esfuerzo que se describe más abajo. Una etiqueta en la cabecera dice si el
  asistente puede ver **filas** o **solo metadatos** en esta conexión, y lo dice
  en la pantalla donde estás trabajando y no solo en Ajustes — una garantía que
  nadie puede ver es una garantía que nadie tiene motivo para creer.

  **Nada de lo que propone se ejecuta desde el chat.** Una sentencia aparece en
  un editor pequeño de solo lectura con un "abrir en el editor" por sentencia,
  que la entrega a una pestaña de consulta: allí ya están todas las
  salvaguardas, el resultado tiene una cuadrícula donde caer, y una escritura es
  algo que ves antes de que se ejecute. Esa es la postura, no una función a
  medias.

  **No se escribe nada en disco.** La transcripción vive y muere con la sesión,
  y es deliberado: contiene nombres de esquema, SQL propuesto y — cuando llegue
  el bucle de herramientas — fragmentos de filas, que es exactamente el
  artefacto sensible que esta función promete no acumular. Lo único que se
  guarda es si las tarjetas de herramienta empiezan desplegadas.

  Dos límites honestos mientras se construye el resto. El modelo **todavía no
  tiene acceso a tu base de datos** — el bucle de herramientas es el siguiente
  trabajo — así que el panel se lo dice con todas las letras, porque un modelo
  sin herramientas al que preguntas "¿qué tablas hay?" se inventará una
  respuesta y la presentará como leída. Y las tarjetas de llamada a herramienta
  están cableadas pero nada las produce aún; cuando lo hagan, cada una nombrará
  la herramienta, sus argumentos y cuántas filas volvieron, porque ese número es
  el que te dice si salieron datos de la máquina.

- **Ajustes → IA: la configuración del asistente integrado, desactivada por
  defecto.** El panel en sí todavía se está construyendo (fase 4 de
  `docs/AI_ROADMAP.md`); lo que entra aquí es todo lo que decide qué se le
  permitiría hacer, de modo que la respuesta a "qué sale de mi máquina" exista
  antes de que pueda salir nada.

  Dos ejes independientes, porque confundirlos es justo el error que este diseño
  quiere evitar. **Dónde corre la inferencia** es un nivel de confianza que
  *declara* el usuario — loopback y RFC1918 solo rellenan la propuesta, y nunca
  se deduce nada del nombre de host, porque el DNS no es una frontera de
  seguridad. **Qué entra en el contexto del modelo** es otra cosa: un endpoint de
  confianza puede leer filas; uno no confiable recibe solo nombres de tablas y
  columnas, tipos, índices y salida de `EXPLAIN`, salvo que una conexión concreta
  lo autorice. "Solo lectura" nunca fue la misma promesa que "no sale nada": un
  asistente de solo lectura que ejecuta `SELECT * FROM pacientes LIMIT 50` ha
  enviado cincuenta registros de pacientes a lo que haya configurado.

  El alcance es por conexión y está apagado en todos los perfiles existentes, y
  el acceso a filas igual; ambos son estrictamente locales, se preservan al
  sincronizar un origen compartido y se limpian al importar, porque lo que un
  modelo de lenguaje puede leer en *esta* máquina no lo decide quien publica a
  dos máquinas de distancia. Funciona cualquier endpoint compatible con OpenAI —
  Ollama, LM Studio, `llama-server`, vLLM o un proveedor en la nube con tu propia
  clave — y se permite `http` sin cifrar a propósito, porque una sola máquina con
  GPU sirviendo a la LAN de la oficina es el despliegue para el que está pensado
  todo esto. Una clave propia va al llavero del sistema, ligada al host de ese
  endpoint para que cambiar la URL no pueda enviarla a otro sitio, y ningún
  comando la devuelve nunca.

  "Probar endpoint" mide lo que el modelo puede hacer de verdad en vez de
  suponerlo: los modelos pequeños a los que se les pide llamar a una herramienta
  suelen responder en prosa, y un bucle de agente sobre uno de esos no es una
  función degradada sino una función rota. El veredicto — con herramientas, solo
  chat, o inalcanzable con el motivo que dé el servidor — se muestra literal, y
  el modo agente avisa cuando el modelo medido no puede sostenerlo.

  Un control de **esfuerzo**, porque casi todos los modelos de la biblioteca
  local actual razonan y a su aire se gastan un párrafo de razonamiento antes
  del primer token útil — que en un panel de chat se lee como un cuelgue. Está
  en el compositor además de aquí, como una pista de cinco topes que va de más
  rápido a más inteligente, porque la elección es una compensación ordenada y
  una lista de seis palabras con el mismo peso no dice nada de eso.
  *Automático* es un interruptor y no un sexto tope, porque no es menos
  esfuerzo: no envía ningún `reasoning_effort`, que es el único ajuste que un
  servidor estricto no puede rechazar — OpenAI rechaza el campo de plano en un
  modelo que no razona. Para un modelo local en modo asistido, quita el
  esfuerzo. Y haga lo que haga el servidor con el campo, el razonamiento que
  llegue incrustado en etiquetas `<think>` se recorta del mensaje en vez de
  pintarse como prosa.

  El propio panel remite a Ajustes → MCP para quien ya paga Claude o ChatGPT:
  esas suscripciones no se pueden gastar a través de HuginnDB, y el conector es
  la vía autorizada.

- **Quien publica un origen puede devolverle una conexión corregida sin volver a
  abrir el editor.** Al guardar una conexión propiedad de un origen desde la
  máquina que lo publica, ahora se ofrece publicar esa única fila. Hasta ahora la
  corrección local y la compartida eran dos formas de expresar la misma
  intención, separadas por Ajustes → editor del origen → buscar la fila →
  cambiar su secreto a «desde el llavero» → publicar; con una contraseña rotada,
  todo el que consume el origen se quedaba fuera durante ese rodeo, y el rodeo
  era fácil de olvidar del todo.

  Es la misma ruta de escritura que la del editor, con una fila ya rellenada: la
  comprobación de rol, la prueba de escritura, el control de conflicto por hash
  de contenido, el `.bak` y el informe de impacto son los mismos que en una
  publicación completa, y una publicación simultánea sigue rechazándose
  devolviendo el documento más nuevo (el aviso abre el editor sobre él, porque
  resolver un conflicto es un trabajo a nivel de documento). Y lo importante: un
  secreto que no ha cambiado viaja byte a byte — corregir un puerto no
  reencripta nada, así que no le cuesta a nadie las ~600 000 rondas PBKDF2 de un
  sobre nuevo, y solo se vuelve a resolver desde el llavero la contraseña que el
  usuario ha reescrito de verdad. El aviso sobrevive al cierre del diálogo de
  conexión, porque «arreglar la contraseña, conectar, listo» es el flujo que una
  credencial rotada produce en realidad.

- **Quien consume un origen puede quedarse con su propia contraseña para una
  conexión compartida hasta que el publicador se ponga al día.** El punto débil
  de un origen compartido siempre ha sido este: el servidor resetea una
  contraseña a las 9 de la mañana y todo el mundo se queda fuera hasta que una
  persona republica. Lo único que se podía hacer era reescribir la contraseña en
  *cada conexión* — `connect` la acepta puntualmente y no la persiste, y guardar
  un perfil propiedad de un origen se rechaza porque la siguiente sincronización
  lo desharía.

  «Guardar aquí la contraseña», en el aviso de solo lectura, la guarda en el
  llavero de este equipo y marca la conexión como que corre con ella.
  Deliberadamente estrecho: cubre el secreto y nada más, así que host, puerto,
  base de datos y el resto siguen siendo cosa del fichero — eso es lo que
  significa «alguien cura esto», mientras que una contraseña que ya no funciona
  es un hecho sobre el servidor y no una decisión de curación. Y caduca sola: el
  override se mantiene mientras el origen siga publicando el mismo secreto
  cifrado frente al que se levantó, y la primera sincronización que traiga otro
  distinto instala la contraseña publicada y lo avisa. «Usar la compartida» lo
  termina antes. Rotar la frase de paso reencripta todos los sobres sin cambiar
  ninguna contraseña, así que caduca todos los overrides de ese origen — con
  aviso, no en silencio.

- **Las opciones de una URI de MongoDB que el formulario no modela ahora viajan a
  través de él en vez de desterrar la conexión al modo texto.** `retryWrites`,
  `w`, `tls`, `replicaSet` y cualquier otra se conservan intactas mientras host,
  puerto, base de datos, usuario y auth source siguen siendo campos editables —
  así que la URI que te da la consola de Atlas se abre como formulario, cosa que
  antes no pasaba nunca.

### Cambiado

- **Desactivar «editar cadena de conexión» ya no se niega en silencio.** Una URI
  que el formulario no puede representar de verdad — un clúster SRV, una lista
  de varios hosts, una contraseña escrita dentro de la cadena o algo que no
  parsea — volvía a activar el interruptor sin que nada en pantalla lo
  explicara, lo que convertía el modo texto en un camino sin retorno: un perfil
  guardado desde una cadena pegada no se podía volver a editar como formulario
  nunca más. Ahora pregunta, nombrando cada cosa que se perdería al plegarlo, y
  conserva todo lo que sí era legible.

### Corregido

- **Las respuestas alucinan menos, y ahora puedes comprobar las que lo hacen.**
  Cada petición pide una temperatura de muestreo baja. El valor por defecto de
  Ollama y de llama.cpp es **0.8** — una configuración de escritura creativa
  para un asistente cuyo trabajo es informar de lo que contiene una tabla, y el
  mecanismo por el que un nombre de columna verosímil que no existe le gana al
  que sí. No se envía cuando has elegido un esfuerzo de razonamiento, porque los
  modelos de razonamiento de OpenAI rechazan los dos juntos.

  El muestreo solo reduce la frecuencia, así que el panel además hace
  comprobable cada afirmación: **una tarjeta de herramienta se abre ahora para
  mostrar lo que llegó.** Las filas se renderizan como tabla — con un valor JSON
  conservado como JSON en lugar de como `[object Object]` — y todo lo demás como
  JSON indentado. Una tarjeta de `run_query` lleva un botón que abre esa misma
  sentencia en una pestaña de consulta, donde están la rejilla, el paginador y
  tus propias ediciones. Y la etiqueta de la tarjeta dice "20 de 41.892" en
  lugar de "20 filas" cuando la respuesta traía el total real de la tabla,
  porque leer una muestra como si fuera la población es una forma concreta de
  equivocarse.

- **Un valor que es JSON o código se muestra ahora como bloque de código incluso
  cuando el modelo se olvida de vallarlo.** En una base de datos de
  configuración la mayoría de las columnas interesantes guardan un documento
  JSON o un fragmento de seudocódigo, y un objeto de 400 caracteres pegado en
  mitad de una frase es ilegible por correcto que sea. El JSON válido se extrae
  y se formatea; un bloque entre llaves de varias líneas que *no* es JSON válido
  — seudocódigo, una plantilla, JSON con claves sin comillas — se conserva
  literal como texto preformateado. Un blob corto o un filtro de mongosh en
  mitad de una explicación se quedan en la frase a la que pertenecen. Los
  prompts piden también la valla, tanto en modo agente como en "Documentar con
  IA"; esto es la mitad que no depende de que el modelo obedezca.

- **Ya no hay que convencer al asistente de que ejecute una consulta.** Incluso
  después de las cuatro correcciones de abajo, algunos modelos terminan el turno
  escribiendo un `SELECT` y esperándote — con una herramienta `run_query` en la
  mano y nada que se lo impida. El modo agente detecta ahora esa forma concreta:
  una respuesta que te entrega una **lectura**, en un turno que no leyó ninguna
  fila y en una conexión donde las filas están permitidas. Le pide al modelo esa
  única llamada y responde con las filas que devuelve.

  Como máximo una vez por turno, así que un modelo terco cuesta un paso extra y
  no el presupuesto entero; nunca con una sentencia que escribe, porque pasarte
  esas es el trabajo del asistente y no un fallo; y nunca cuando el endpoint es
  solo-metadatos, donde proponer la sentencia es el comportamiento correcto. El
  paso extra aparece en la Consola como cualquier otro, bajo el filtro de IA.

- **El asistente escribía las consultas y esperaba a que las ejecutaras tú en
  lugar de ejecutarlas.** Ya elegía sus herramientas por su cuenta, pero se
  atascaba en el último paso: imprimía un `SELECT` y te pedía que lo ejecutaras,
  en modo agente, con una herramienta `run_query` en la mano. Cuatro causas,
  todas nuestras:

  **Nunca se le decía con qué motor estaba hablando.** Nada en el prompt
  nombraba el driver, así que escribía el dialecto que más había visto — `LIMIT`
  contra SQL Server, comillas invertidas contra Postgres, SQL contra MongoDB — y
  una sola llamada fallida basta para que un modelo pequeño deje de fiarse de sí
  mismo y te pase la sentencia. Ahora cada turno empieza con el nombre de la
  conexión, su motor, su base de datos, cómo cita identificadores ese motor y
  cómo pagina.

  **`DESCRIBE` se clasificaba como escritura.** Es como un modelo le pregunta a
  MySQL por la forma de una tabla, y se rechazaba como mutación con la
  instrucción de dártela a ti. `DESCRIBE`/`DESC` y un `(` inicial — como en
  `(SELECT …) UNION (SELECT …)` — se reconocen como las lecturas que son. El
  editor se lleva la misma corrección: ahí `DESCRIBE t` reportaba un número de
  filas en lugar de mostrar las columnas.

  **Un solo rechazo servía para tres problemas distintos.** Una escritura, un
  lote de dos sentencias y un `USE` recibían todos "presenta la sentencia al
  usuario como propuesta" — la instrucción más contundente del bucle. A un lote
  se le dice ahora que envíe una sola sentencia, a un `USE` que la conexión ya
  está abierta en su base de datos y que cualifique el nombre, y solo una
  escritura de verdad recibe la indicación de proponer algo.

  **Una conexión MongoDB abierta en una base de datos no funcionaba en
  absoluto.** Esas llevan un id sintético que no tiene perfil propio, así que
  cada llamada a herramienta volvía con "no connection named …". Ahora se
  resuelve a su padre, y la base de datos que tenías abierta pasa a ser el
  destino por defecto en lugar de descartarse.

- **Una escritura podía esconderse detrás de una lectura.** `SELECT 1; DELETE
  FROM t` se clasificaba por su primera palabra clave, así que pasaba como
  lectura — para el panel de IA, que nunca escribe, y para una conexión MCP en
  `read-only`. Que el `DELETE` llegara a ejecutarse dependía del driver: lo
  rechaza el protocolo preparado en PostgreSQL y MySQL, y lo ejecutan un lote
  T-SQL y SQLite. El nivel de una sentencia es ahora el más estricto de todas
  las sentencias del texto, ignorando correctamente los puntos y coma dentro de
  literales de cadena, identificadores citados, comentarios y cuerpos con
  comillas de dólar de Postgres. Varias lecturas en una misma cadena siguen
  siendo una lectura.

- **El botón de limpiar de tres campos de búsqueda mostraba una clave de
  traducción en crudo.** `common.clear` lo usaban los buscadores de Ajustes → MCP
  y Ajustes → Pulse y dos diálogos de conexión, y no existía en ninguno de los
  dos idiomas, así que la etiqueta accesible se leía como `common.clear` tanto en
  inglés como en español.

## [1.21.5] — 2026-09-07

### Corregido

- **Una conexión de MongoDB inalcanzable se anunciaba como conectada.** Apuntar
  un perfil de MongoDB a un host caído, a un puerto equivocado o a un túnel SSH
  muerto producía una notificación verde de "Conectado", y el único rastro del
  fallo era una línea roja dentro del árbol del esquema — que ni siquiera se
  dibuja si la fila de esa conexión no está expandida, y desaparece del todo
  mientras hay un filtro activo en el árbol. Tres minutos más tarde el keepalive
  se daba cuenta y ofrecía reconectar, y esa era la primera cosa cierta que la
  app había dicho al respecto.

  Dos causas, y había que quitar las dos. El driver de MongoDB construye su
  cliente sin tocar la red y, al contrario que los otros cuatro drivers, nada
  hacía ping después — así que `connect` no podía fallar, y el error real nacía
  ocho segundos más tarde, en la primera lectura del esquema. Y una lectura del
  esquema fallida se guardaba en la conexión en lugar de reportarse, así que el
  código que acababa de abrirla no podía saber que había fallado y seguía
  adelante anunciando el éxito.

  MongoDB comprueba ahora el servidor al conectar, como ya hacían PostgreSQL,
  MySQL, SQLite y SQL Server, así que una conexión que no puede funcionar falla
  donde la has pedido — nombrando la conexión, con el mensaje del propio driver
  y un botón para copiarlo. Una lectura del esquema que falle más tarde también
  se reporta: una conexión entera, las columnas de una tabla o sus índices, que
  hasta ahora se escribían en un campo que no mostraba nada. Los fallos de una
  misma conexión se agrupan en una sola notificación con un contador, así que
  expandir una base de datos de cuarenta tablas contra un servidor que se ha ido
  es una tarjeta, no cuarenta.

  Los mensajes de error de MongoDB vuelven a ser legibles, además. Llegaban con
  la contabilidad interna del driver pegada detrás — y, en cualquier error de
  comando, con un volcado hexadecimal de la respuesta completa del servidor — en
  un mensaje pensado para leerse en una fila estrecha del árbol.

- **"Indexar todas las bases de datos" podía saltarse medio servidor y decir que
  había ido bien.** Una base de datos cuya lista de tablas fallaba se contaba
  como cargada, y todo fallo que no fuera un rechazo por límite de conexiones se
  reducía a un número con el motivo descartado. El árbol de conexiones y la
  paleta de comandos dicen ahora cuántas no respondieron, y por qué.

- **El filtro del árbol podía esconder el fallo del que acababa de avisar.** Una
  conexión cuyo esquema no se ha podido leer tiene el mismo aspecto que una
  vacía, así que al filtrar el árbol su fila se atenuaba, mostraba un `0` y se
  plegaba a una sola línea — que es justo lo que quitaba el mensaje de error de
  la pantalla. Ahora la fila muestra un `!`, lleva el mensaje al pasar por
  encima, y no se atenúa ni se pliega: una conexión que el servidor no
  responde es la fila que más necesitas ver. Un servidor multi-base cuyas bases
  concretas no responden también lo dice, en lugar de contarlas como cero.

- **Toda acción del menú contextual sobre un nodo de base de datos colapsado
  fallaba en silencio.** "Nueva consulta aquí", "Nueva tabla", "Seguridad",
  exportar, importar, "Nueva colección" y "Refrescar" tienen que abrir antes la
  base de datos, y cuando eso fallaba el error se escribía en una parte del
  árbol que solo se dibuja con el nodo expandido: la opción del menú no hacía
  nada y no decía nada. Un `DROP DATABASE` rechazado hacía lo mismo, mientras su
  éxito sí se reportaba desde la 1.21.3.

- **Con los pools compartidos activados, una conexión abierta por el conector
  MCP no la cerraba nada.** Activar Ajustes → Conexiones → "Compartir pools con
  el conector MCP" hace que la app de escritorio abra la conexión que necesita
  una llamada de herramienta, y eso es justo lo que se busca: un único
  presupuesto por servidor para toda la máquina. Lo que hacía además era darle a
  esa conexión el ciclo de vida de una que hubieras abierto tú: cinco de los
  diez slots del presupuesto por defecto reservados, un latido de keepalive
  manteniendo un socket físico abierto indefinidamente por encima del tiempo de
  inactividad, y residencia permanente en el mapa de pools de la app.

  Nada en el producto podía liberarla. El segador nunca cierra un pool de primer
  nivel, con el argumento de que es una conexión que el usuario abrió
  explícitamente y que la interfaz muestra como conectada — y aquí ninguna de
  las dos mitades es cierta: ninguna ventana lista una conexión abierta por el
  conector, porque una ventana solo muestra las que ha abierto ella. "Liberar
  pools inactivos" la ignoraba por el mismo motivo. Reiniciar la app era la
  única salida. Y con los pools compartidos *desactivados*, el conector abre su
  propio pool y lo cierra tras cinco minutos de inactividad. La misma conexión,
  de la misma llamada, era desechable en un modo e inmortal en el otro, y de ahí
  la sensación de que las conexiones inactivas a veces se liberaban y a veces
  no.

  Una conexión que pide el conector queda ahora marcada como tal y se trata como
  lo que es: reserva la porción pequeña del servidor, del tamaño de una vista de
  base de datos, en lugar de la de una conexión completa; no recibe latido; y se
  cierra en cuanto lleva inactiva el tiempo de **Cerrar conexiones del conector
  inactivas tras** — cinco minutos por defecto, los mismos que aplica el
  conector a las suyas, así que el comportamiento ya no depende de qué proceso
  tenga el pool. El conector la reabre de forma transparente en su siguiente
  llamada. "Liberar pools inactivos" también las cierra ahora, dejando solo las
  conexiones que has abierto tú.

  Si más tarde te conectas tú a una de esas conexiones, la app la **adopta**:
  pasa a ser una conexión tuya normal, con latido incluido, y deja de cerrarse
  automáticamente. Y como por construcción eran invisibles en el producto,
  Ajustes → Conexiones muestra ahora cuántas de las conexiones de la app las
  abrió el conector, junto al interruptor del puente.

- **Un servidor inalcanzable se reportaba como "too many connections", treinta
  segundos tarde y con el remedio equivocado.** Un perfil MySQL apuntando a un
  puerto cerrado, un host detrás de un firewall que descarta los SYN, o un túnel
  SSH que se había caído producían `too many connections: HuginnDB's own
  connection pool timed out waiting for a free slot — HuginnDB is currently
  holding 0 connection pool(s) and 0 per-database pool(s)`. Ninguna parte de esa
  frase describía el fallo real, y la app actuaba en consecuencia: el frontend
  reconoce el marcador de límite de conexiones por subcadena, así que ofrecía
  "liberar pools inactivos y reintentar" para un servidor que no estaba lleno, y
  abría el cortacircuitos de la búsqueda entre bases de datos del explorador por
  un diagnóstico que no tenía nada que ver con la capacidad.

  La causa está en `sqlx`, no en la clasificación. `PoolOptions::connect` es
  eager, y su bucle de reintento trata una conexión rechazada y un error de base
  de datos *transitorio* como motivo para esperar y volver a intentarlo hasta
  agotar `acquire_timeout` — treinta segundos — y entonces devuelve
  `PoolTimedOut` descartando el error real. El pool nunca podía decir por qué
  había fallado, y `PoolTimedOut` cargaba con dos significados sin relación: "tu
  propio pool está saturado", que es correcto para un pool que ya existe, y "no
  llegué nunca al host", que no lo es. Postgres lo empeoraba en el otro sentido:
  `53300` (`too_many_connections`) cuenta como transitorio, así que un Postgres
  genuinamente lleno también se reintentaba treinta segundos y luego se le
  echaba la culpa a nuestro pool en vez de reportar las palabras del servidor.

  Abrir un pool ahora comprueba primero el endpoint, con una única conexión
  fuera del pool que no tiene bucle de reintento, y construye el pool de forma
  perezosa detrás. Una conexión rechazada falla al instante y lo dice; una
  contraseña incorrecta sigue siendo una contraseña incorrecta; un rechazo real
  por límite — MySQL `1040`, Postgres `53300` — sigue reportándose como tal, con
  el mensaje del propio servidor; y solo un host que descarta paquetes en
  silencio llega al timeout, donde se reporta como lo que es, con las mismas
  palabras que SQL Server ha usado siempre para ese caso. Al ser el pool
  perezoso, el camino de apertura ya no puede producir `PoolTimedOut`, y eso es
  lo que mantiene los dos significados separados en lugar de adivinados.

  Además: el error ya no añade "HuginnDB is currently holding 0 connection
  pool(s) and 0 per-database pool(s)". Esa frase existe para revelar nuestra
  propia parte del límite del servidor, y salía a cero precisamente cuando menos
  servía — el pool que acaba de fallar nunca se cuenta, así que la primera
  conexión de una sesión siempre decía cero, y eso es lo que hacía convincente
  el diagnóstico equivocado. La nota sobre los demás clientes de la máquina se
  mantiene, porque esa sí explica un servidor que no hemos llenado nosotros.

- **`describe_table` no podía describir una vista de MongoDB — justamente la
  única relación cuya descripción es la forma de leerla.** El pipeline
  almacenado de una vista *es* su definición, y `describe_relation_inner` lo
  lee: primero la estructura, después el cuerpo de la vista. Ambas mitades eran
  estrictas, así que en una vista la primera decidía si la segunda llegaba a
  ejecutarse — y en una vista siempre fallaba. `listIndexes` responde
  `CommandNotSupportedOnView` (código 166) en toda vista, porque una vista no
  tiene índices propios; y antes incluso de eso, `$sample` no puede coger su
  camino rápido en una vista — el servidor reescribe la agregación para
  ejecutar primero el pipeline de la vista, con lo que nuestra etapa deja de
  ser la primera y nunca obtiene el cursor aleatorio. Sobre una vista de
  millones de documentos degenera en leer todo lo que la vista produce, así que
  la inferencia de campos agotaba su tiempo. En ambos casos quien llamaba
  recibía un error y nunca el pipeline, que no se había llegado a leer.

  Los dos fallos ya estaban comprendidos en este mismo archivo — para las
  colecciones time-series, que son ellas mismas vistas sobre sus buckets — y la
  consulta al catálogo que los evita ya existía. Solo preguntaba por
  time-series. Ahora clasifica la relación una sola vez (`RelationKind`) y las
  dos mitades usan la respuesta: una vista se salta `listIndexes` en lugar de
  fallar en él, infiere sus campos leyendo una página acotada en vez de
  `$sample`, e informa de que no tiene campos antes que de no poder describirse
  cuando ni eso termina a tiempo. El muestreo de una colección normal sigue
  siendo estricto — ahí un fallo es un fallo de verdad.

  Detectado con `describe_table` sobre una vista de producción; encontrado
  leyendo el error del driver en lugar de la promesa de la herramienta.

## [1.21.4] — 2026-09-07

### Añadido

- **La app dice lo que ha hecho cuando el resultado está donde no lo ves.**
  Conectar (el único gesto que tarda segundos de forma fiable, y el que la gente
  lanza antes de mirar a otro lado), "desconectar todo" y su recuento, aplicar
  un cambio de estructura o de vista, eliminar o renombrar una tabla, una vista
  o una base de datos, crear, reconstruir, eliminar u ocultar un índice de
  MongoDB, publicar en un origen compartido, el resultado de una importación
  — que hasta ahora se iba con el diálogo que lo mostraba —, una política de
  escritura de MCP, y copiar varias filas al portapapeles, donde el recuento es
  toda la pregunta. Todo en píldora: una línea, seis segundos y a la campana.

  Deliberadamente *no* todo. Una desconexión suelta apaga su propia fila y
  cierra sus propias pestañas; un reset de los atajos o del layout es una lista
  o una pantalla que visiblemente vuelve atrás; duplicar un tema lo añade a la
  lista que tienes delante. Confirmar eso es el ruido que hace que la gente deje
  de leer las que sí importan (CONTRIBUTING → "Feedback and transition state":
  confirma una escritura solo cuando su efecto no es autoevidente).

- **Una anatomía de notificación de una línea, y una regla que decide cuándo no
  basta.** Una confirmación era hasta ahora una tarjeta de 380 px con su riel,
  su medallón de 28 px, su hueco de cuerpo y su fila de botones — para entregar
  las palabras "Celda guardada". Toda notificación que no sea un error es ahora
  una **píldora**: 32 px, una línea, icono más título más una cola opcional en
  monoespaciada tenue, y se descarta pulsándola. Los errores y las
  notificaciones de fichero se ven exactamente igual que antes, porque ambos
  llevan siempre algo sobre lo que actuar: un mensaje del driver que merece
  copiarse, un nombre de archivo que abre la carpeta.

  La mitad interesante es la frontera. "Lo que no es error es píldora" solo es
  seguro si algo se da cuenta de cuándo la píldora es la forma equivocada, así
  que `surfaceFor`, en `lib/notify.tsx`, pregunta *¿esto cabe en una línea?* en
  vez de *¿de qué tipo es esto?*: lo que lleve botones, una ruta de fichero o
  una descripción que no quepa escala a tarjeta y conserva todo lo que tenía. Se
  decide una sola vez, en la misma costura que ya gobierna duración, agrupación
  e historial — nunca en el punto de llamada, porque un punto de llamada que
  tuviera que acordarse sería un punto de llamada que descarta sus propios
  botones en silencio.

- **Las dos anatomías se apilan en dos esquinas, y Ajustes → Notificaciones
  tiene ahora un selector de posición para cada una.** Las píldoras van por
  defecto abajo al centro y las tarjetas se quedan abajo a la derecha, así que
  una confirmación ya no hace cola detrás de un error que nadie ha leído.
  Elegir la *misma* esquina para las dos no es una colisión que haya que
  arbitrar: es la forma de que vuelvan a ser una sola pila, y es un único camino
  de código, no un caso especial. Las dos filas son accesibles desde la paleta
  de comandos.

### Cambiado

- **Una píldora vive la duración base, donde la tarjeta a la que sustituye vivía
  un múltiplo.** El multiplicador compra tiempo de lectura y una píldora no
  tiene nada que leer; un aviso que de verdad lleve algo sobre lo que actuar ya
  se ha convertido en tarjeta para entonces, y recupera su ×2 con ella. La
  píldora tampoco tiene hairline de drenaje: una barra recta de 2 px recortada
  por un radio de 999 px se lee como una lente, y un aro alrededor de un icono
  de 14 px significaría "tiempo restante" en una confirmación y "trabajo hecho"
  en una barra de progreso — una forma, dos significados. El coste conocido es
  que "expandir al pasar el ratón" ya no tiene acuse visible en una píldora.

- **Una tarea larga que falla ahora se muda en lugar de resolverse en su sitio.**
  Una notificación de `progress` se convierte normalmente en su propio desenlace
  sin abandonar su hueco; una *píldora* de progreso que falla hacia una
  *tarjeta* de error pertenece a otra pila, así que se retira y el error se
  levanta de nuevo. La promesa del mismo hueco se mantiene allí donde todavía
  puede cumplirse — `progress → success` no se mueve nunca.

### Corregido

- **Una conexión que se cae sola ahora lo dice, con un botón de Reconectar.** El
  latido de tres minutos marca las conexiones perdidas desde la 1.4.0, pero solo
  como una insignia en una fila de un panel que puede no estar abierto — así que
  lo primero que uno se enteraba de verdad era un error críptico del driver en
  mitad de la siguiente consulta. Llevar una acción la escala de píldora a
  tarjeta, que es lo correcto: un pool muerto no es algo para mirar de reojo.
  Una tarjeta por conexión por muchas veces que el latido lo repita, y solo en
  la transición a "perdida".

- **Un restore de sesión que no puede reabrir una conexión deja de hacerlo en
  silencio.** Entrar en un entorno reabre todo lo que tenía; un fallo era un
  `console.warn`, y la pestaña se restauraba igualmente — así que el usuario se
  quedaba con una vista de tabla sin nada detrás y se enteraba cuando una
  consulta devolvía un error del driver. Un aviso para todo el lote, no uno por
  conexión: un servidor caído se lleva por delante todas las suyas.

- **Un origen compartido que te cambia las conexiones mientras trabajas ahora
  dice cuántas.** `syncAll` corre en un sondeo y al arrancar, y puede añadir o
  actualizar perfiles y entornos enteros; el silencio ahí es como la edición de
  un compañero acaba pareciendo "se me han movido las conexiones solas". Solo
  cuando algo ha cambiado de verdad — una tarjeta de "no ha pasado nada" cada
  pocos minutos es justo el ruido que hace que la gente deje de leerlas.

- **Tres copias de "conecta este perfil" pasaron a ser una.** El árbol de
  conexiones usaba el `connectAndWarm` compartido; la barra de estado y la
  paleta de comandos llevaban cada una su versión copiada, y ya habían
  divergido: una daba la pista de driver equivocado al fallar y la otra no. El
  *desconectar* de la paleta era una llamada pelada al store, que cerraba el
  pool sin soltar el esquema cacheado ni las pestañas que apuntaban a él — la
  misma laguna que se arregló para "desconectar todo" en la 1.20.0.

- **Una escritura rechazada por la base de datos no dejaba rastro alguno.**
  Guardar una celda desde el editor en línea, el selector de clave ajena, Ctrl+V
  o "Poner a NULL" acababa en `.catch(() => {})` — cinco casos, repartidos en
  tres ficheros. El servidor rechazaba el `UPDATE`, el destello de confirmación
  simplemente no ocurría, y el silencio había que leerlo como fallo justo
  después de haber enseñado al usuario a leer el silencio como éxito. El aviso
  va en la misma costura de `DataGrid` que ya gobierna el destello, así que
  cubre todos los caminos de guardado existentes y los que se añadan después sin
  que ninguno tenga que conocer la regla; el editor modal y el panel lateral
  quedan fuera, porque los dos mantienen el editor abierto e imprimen el mensaje
  del driver junto al valor que lo provocó.

- **Todo el CRUD de entornos fallaba en silencio.** Crear, renombrar, eliminar,
  reordenar y recolorear un entorno acababan cada uno en `set({ error })` contra
  un campo que ningún componente ha renderizado nunca. Ahora pasan todos por un
  único helper `fail` que registra *y* avisa. Eliminar además dejó de mentir
  sobre lo ocurrido: el diálogo de confirmación se cerraba incluso cuando el
  borrado era rechazado — el entorno seguía ahí y el diálogo decía que ya no —
  así que `remove` devuelve si funcionó y el diálogo se queda abierto cuando no.

- **Seis handlers de Ajustes → Orígenes tenían `try`/`finally` sin `catch`.**
  Registrar un origen, editarlo, crear un documento de origen, eliminarlo y
  adoptar o retirar perfiles desaparecidos dejaban una promesa rechazada sin
  capturar y un diálogo que sencillamente dejaba de responder. Todos ellos son
  escrituras cuyo efecto está en otra parte, así que tampoco había nada en
  pantalla de lo que deducir el resultado.

- **Otros sitios donde un fallo iba a la consola y a ningún otro lado**: la
  lista de conexiones al no poder cargarse (que parecía una instalación recién
  hecha), un fichero de preferencias que no se podía escribir (ajustes que en
  silencio no iban a sobrevivir al siguiente arranque) ni leer (los valores por
  defecto, presentados como si no hubiera pasado nada), "Nueva ventana" desde el
  menú Ventana — el único de sus tres puntos de entrada que se callaba —, un
  enlace de JSON Schema activado o borrado contra un store que rechazaba la
  escritura, y una consulta de privilegios cuyo fallo se pintaba como la
  respuesta tranquilizadora, y falsa, de que el usuario no tiene ninguno.


- **Las tres ventanas raíz ya no llevan cada una su propia copia del contenedor
  de notificaciones.** `App`, la ventana de pestaña desacoplada y la ventana de
  Pulse tenían una invocación de `<Toaster>` idéntica, con el margen de borde
  escrito por cuarta vez dentro de la píldora de desbordamiento — cuatro sitios
  que mantener sincronizados para una sola decisión, y la razón de que la
  afirmación con la que abre `lib/notify`, "nada fuera de este módulo importa
  `sonner`", hubiera dejado de ser cierta sin que nadie lo notara. Ahora un solo
  `<NotificationHosts>` es dueño de todos los hosts, y vuelve a ser cierta.

## [1.21.3] — 2026-09-07

### Añadido

- **Un toggle de "Conexión directa" en el formulario de conexión de MongoDB**
  (tanto en el de nueva conexión como en el de editar), que añade
  `directConnection=true` a la URI derivada. Es lo que hace falta cuando estás
  llegando a un miembro concreto de un replica set a propósito — a través de una
  máquina puente, o para leer de un secundario en particular: sin él el driver
  toma el host que escribiste como semilla, lee de su respuesta `hello` las
  direcciones reales de los miembros del conjunto e intenta llegar a *esas*, así
  que una conexión a un host perfectamente alcanzable falla porque los nombres
  que anuncia son internos y esta máquina no los resuelve. Hasta ahora la única
  forma de ponerlo era la escotilla de "Editar cadena de conexión", que tenía
  trampa: el parser del formulario rechazaba cualquier opción de URI que no
  modelara, así que un perfil guardado por esa vía volvía a abrirse en modo de
  edición manual para siempre, con host, puerto y base de datos en gris.

  Modelado como una opción de consulta dentro de la URI derivada y no como un
  campo nuevo del perfil, que es la razón de que no haya cambiado nada en el
  backend: el driver lee `directConnection` directamente de la cadena de
  conexión, y un perfil de MongoDB siempre guarda su URI. Como consecuencia se
  exporta, se importa y se sincroniza por un origen compartido sin trabajo
  extra — y deliberadamente *no* se añade a los campos que una sincronización de
  origen preserva en local, porque a diferencia de los toggles de MCP y Pulse
  esto es un hecho sobre la topología del servidor, no una decisión de esta
  máquina. Lo dicta quien publica, igual que el host y el puerto.

### Corregido

- **El árbol de esquema y el área de pestañas ya no siguen vivos mientras un
  cambio de entorno desmonta la sesión.** Cambiar de entorno no es mover un
  puntero: `switchTo` vuelca el estado de pestañas saliente, vacía `useTabs`,
  limpia la conexión seleccionada y luego cierra cada pool vivo **de uno en
  uno** — cada uno un viaje de ida y vuelta, y uno *por base de datos* a través
  de un túnel SSH o un pooler — antes de reconectar el conjunto entrante y
  reponer la distribución guardada. Durante toda esa ventana, que en una carga
  real son segundos y no fotogramas, el árbol de conexiones seguía siendo
  plenamente interactivo sobre un store deliberadamente a medio desmontar: un
  clic podía abrir un pool del entorno que se estaba *abandonando* mientras se
  cerraban sus hermanos, o lanzar un `list_tables` contra un pool en pleno
  desmontaje y dejar un error obsoleto de "no conectado" sobre una conexión que
  acaba perfectamente sana. El store ya modelaba bien la transición
  (`switchingTo` nombra el entorno al que se entra, no un booleano — ver el
  gotcha #61), pero solo lo consumían los tres *selectores* de entorno; nada del
  árbol ni de la columna central sabía siquiera que había un cambio en marcha.
  Ahora ambos quedan sellados por una única costura, `EnvironmentSwitchGuard`,
  que los cubre con una cortina que sí recibe el puntero y marca el contenido
  como `inert` para que el teclado tampoco pueda atravesarla — el árbol tiene su
  propio manejo de teclas y su `data-kb-scope`, así que una cortina por sí sola
  no habría detenido a una fila que ya tuviera el foco. El rail de entornos se
  queda fuera de la guardia a propósito: ya modela esa misma transición y es la
  superficie que debe seguir siendo legible mientras dura el cambio.

- **"Nuevo entorno → partir de X" queda cubierto por la misma guardia.** Esa ruta
  entra dos veces en el entorno nuevo: un `switchTo` barato contra algo todavía
  vacío y, después de escribir el estado de lanzamiento replicado, un segundo
  `restoreSession` que es el que realmente abre las conexiones copiadas. Para
  entonces `switchTo` ya había limpiado `switchingTo`, así que la más lenta de
  las dos pasadas era justo la que corría sin guardia. Ahora `createAndEnter`
  mantiene el flag durante toda su pasada de siembra y lo limpia en un `finally`,
  de modo que un fallo ahí no puede dejar la interfaz cubierta.

  La restauración de arranque queda deliberadamente *sin* guardia: no cierra
  ningún pool ni vacía ningún store de pestañas, así que ahí el riesgo no existe,
  y cubrir el árbol durante todo el reconnect de arranque cambiaría un fallo real
  por una peor primera impresión.

- **Copiar ya llega al portapapeles del sistema, y pegar ya no pide permiso.**
  Las dos mitades del portapapeles pasaban por la API del propio webview, y eso
  estaba mal por dos motivos distintos. Ctrl+V llamaba a
  `navigator.clipboard.readText()`, y WebView2 responde a eso con su propio
  diálogo de "permitir que este sitio vea el texto e imágenes copiados en el
  portapapeles" — correcto en una pestaña de navegador, absurdo en una
  aplicación de escritorio instalada y en un pegado que el usuario acaba de
  pedir, e imposible de estilar, reescribir o preconceder desde la app porque es
  del motor, no de HuginnDB. En paralelo, todas las rutas de copia llamaban a
  `writeText()`, que aterriza en el canal propio del webview: pegar de vuelta
  *dentro* de HuginnDB funcionaba, que es justo lo que hacía que esto pareciera
  sano, pero el valor nunca estaba en el portapapeles del sistema — copia
  cualquier otra cosa en cualquier otra aplicación y la celda que habías copiado
  simplemente había desaparecido, y tampoco aparecía nunca en el historial del
  portapapeles del sistema. Ahora ambas pasan por el plugin de portapapeles de
  Tauri, así que la lectura ocurre en Rust (no hay modelo de permisos del webview
  al que preguntar) y la escritura va al portapapeles del SO, donde mira el resto
  del escritorio.

  De paso, `navigator.clipboard` ha dejado de estar disperso: el helper existía
  pero seis puntos lo saltaban por completo — "Copiar nombre" y "Copiar SELECT"
  del árbol de esquema, la salida de pipeline y su diálogo de exportación, el
  botón de copiar de los ajustes de MCP, el respaldo del historial de la barra de
  estado y el copiador de errores del diálogo de conexión — cada uno con su
  propio (inexistente) manejo de errores. Los siete comparten ahora una única
  costura, que además ha salido de `lib/grid/` porque el sistema de
  notificaciones llevaba tiempo importándola. Tres confirmaciones de "Copiado"
  que se disparaban sin esperar a la escritura ahora la siguen, porque por fin
  un fallo es algo observable.

  Dos límites que conviene dejar dichos: en Linux el portapapeles pertenece al
  proceso que lo fija, así que un valor copiado desde HuginnDB sigue
  desapareciendo al cerrar HuginnDB (es una propiedad de la plataforma; Windows
  no se ve afectado), y Ctrl+C/Ctrl+V siguen sin llegar a la vista de lista de
  documentos de MongoDB, algo anterior a este cambio.

## [1.21.2] — 2026-09-04

### Corregido

- **Los editores de estructura y de vista ya no cierran toda la aplicación en
  una build de Windows en release.** Abrir la estructura de una tabla o una
  vista — en cualquier driver, en cualquier tabla — mataba el proceso de
  forma sistemática justo cuando terminaba la pantalla de "cargando", sin
  dejar más rastro que `thread 'main' has overflowed its stack` en stderr,
  invisible en una instalación normal porque release enlaza la app como
  binario de subsistema `windows` (sin consola). Nunca se reproducía con
  `pnpm tauri:dev`, lo que hacía parecer que el problema estaba en el
  frontend; la comprobación por bisección demostró lo contrario — una build
  `--debug` sin optimizar del mismo bundle de frontend de producción tampoco
  fallaba, solo lo hacía una build real de `tauri:build` en release. La
  variable real era el optimizador de Rust: el enlazador de MSVC reserva por
  defecto 1 MiB de stack para el hilo principal (8 MiB en Linux/macOS), y el
  inlining de release colapsa la cadena de llamadas de introspección de
  estructura/vista (`ensure_view` → `pool_for` → las consultas a
  `information_schema`) en marcos de pila más grandes de lo que necesita esa
  misma cadena sin optimizar — de sobra por debajo de 1 MiB en dev, justo por
  encima una vez optimizada. Solucionado reservando 8 MiB para el hilo
  principal vía `/STACK` en el enlazador
  (`src-tauri/.cargo/config.toml`, solo Windows) en lugar de reestructurar la
  cadena de llamadas para encajar en un presupuesto arbitrariamente pequeño.

- **Los totales de almacenamiento de Pulse ya no cuentan el espacio libre dos
  veces en MongoDB.** `StorageItem::total()` sumaba
  `data_bytes + index_bytes + free_bytes` sin condiciones, lo cual es correcto
  para MySQL — `Data_free` está fuera de `Data_length` — pero incorrecto para
  MongoDB, donde `freeStorageSize` es *la porción reclamable de*
  `storageSize` según WiredTiger, ya incluida dentro de `data_bytes`. El total
  reportado de cada colección de MongoDB estaba por tanto inflado por su
  propio espacio libre, lo que además distorsionaba el ranking del top-N
  (`sort_unstable_by_key` sobre ese mismo total) — una colección fragmentada
  podía superar a una genuinamente más grande y dejarla fuera de la lista.

  `StorageItem` ahora lleva `free_is_within_data` (fijado por driver en la
  construcción — `false` en MySQL, `true` en MongoDB) y un `total_bytes`
  calculado en el backend que lo tiene en cuenta, así que el frontend ya no
  vuelve a derivar la suma por su cuenta — las dos superficies de Pulse
  (`PulsePanel`, `PulseWindow`) y el gran total de `usePulseView` duplicaban
  cada una la misma fórmula, que es exactamente lo que permitió que
  divergieran para MongoDB en primer lugar. La barra de almacenamiento
  segmentada también refleja ahora la semántica corregida: en MongoDB, la
  porción libre se pinta como una superposición rayada en el borde final del
  segmento de datos (está *dentro* de él) en lugar de un tercer segmento que
  antes sumaba su propio ancho sobre un total ya inflado.

## [1.21.1] — 2026-09-03

### Añadido

- **El autocompletado en línea del editor de agregación ahora inserta la
  estructura completa de una etapa, no solo su nombre.** Elegir `$group`
  desde el `Select` de la cabecera ya sustituía el cuerpo por el snippet
  completo (`_id`, un acumulador); escribir `$group` en el editor y aceptar
  la sugerencia solo insertaba `$group: `, dejando el resto para escribirlo
  a mano — el hueco que esto cierra. Cada etapa del catálogo tiene ahora un
  snippet de Monaco (sintaxis de tabstops, `InsertAsSnippet`) junto al
  plano, así que Tab recorre `_id`, el acumulador, el nombre del campo — la
  misma interacción que tiene el autocompletado de etapas de Compass.

  **Un acumulador de `$group`/`$bucket`/`$bucketAuto`/`$setWindowFields`
  (`$sum`, `$avg`, `$push`, …) recibe el mismo tratamiento, y necesitó su
  propio catálogo para hacerlo bien.** Un acumulador nunca es válido a secas
  — solo `{ $sum: 1 }` es legal, no `$sum: 1` suelto — así que no podía
  compartir la lista plana de operadores de expresión que sí comparten
  `$concat`/`$cond`; se ofrece solo mientras el cursor está definiendo el
  valor de un campo de salida dentro de una de esas cuatro etapas (nunca
  para el propio `_id` de `$group`, que es una expresión, no una
  reducción), e inserta el objeto envolvente completo.

  Otro arreglo de propina: escribir `$` en cualquier sitio volcaba antes
  los 28 nombres de etapa en la lista sin importar la posición — dentro de
  un filtro `$match` anidado, por ejemplo. Las sugerencias de etapa ahora
  solo se ofrecen en la clave de nivel superior del propio cuerpo de una
  etapa, o en la raíz del documento de etapas de una subpipeline anidada
  (`$lookup.pipeline`, una rama de `$facet`, `$unionWith.pipeline`).

  Escapar `$` a mano en 28 snippets (`\$` allí donde es un carácter
  literal, nunca un tabstop — la gramática de snippets de Monaco lee un
  `$nombre` suelto como una variable TextMate sin resolver y la descarta
  en silencio) es justo el tipo de cambio en el que se esconde una errata;
  `stages.test.ts` despoja la sintaxis de tabstops de cada snippet hasta
  dejarla en texto plano y comprueba que reproduce el snippet plano
  existente byte a byte.

  Dogfooding contra un `$group` real sacó a la luz cuatro huecos más:

  - La rama de acumulador de arriba solo reconocía el hueco *a secas*
    (`count: $su`, sin llaves todavía) — pero al hacer Tab dentro del
    propio snippet que describe esta entrada, el cursor aterriza *dentro*
    de un `{ }` ya abierto (el tabstop de acumulador que él mismo
    sembró), un nivel más adentro. Es un segundo hueco, igual de válido,
    que la primera versión nunca cubrió, así que el widget recurría a
    cualquier operador de expresión sin relación que compartiera el
    prefijo escrito.
  - Un operador de expresión (`$concat`, `$cond`, …) siempre es una
    *clave* de objeto — nunca es válido como valor a secas — pero la
    lista de completado ofrecía el conjunto entero de ~50 entradas en
    *cualquier* posición precedida por `$`, incluida una referencia a
    campo tan plana como el propio `_id: "$field"` de `$group`. Eso
    enterraba la única sugerencia realmente útil ahí (un nombre de campo
    real de la colección) bajo ruido de operadores; la lista ahora solo
    se ofrece donde el cursor está eligiendo una clave.
  - Editar ese mismo valor de `_id` a mano nunca reabría el popup de
    sugerencias: `quickSuggestions` de Monaco deja `strings` desactivado
    por defecto, así que el widget solo se abre con el carácter
    disparador inicial (`"`/`$`), nunca de nuevo mientras se escriben
    letras normales después — exactamente lo que ocurre al sobrescribir
    el propio placeholder de un snippet.
  - Y una vez arreglados esos tres, las sugerencias de nombre de campo
    *seguían* sin aparecer, en silencio: Monaco filtra cada elemento de
    completado comparando su propia **label** con el texto que abarca en
    ese momento el rango a reemplazar, y un valor prefijado con `"$"`
    reemplaza un rango que incluye el `$` que el usuario ya escribió —
    pero la label de los elementos de campo era el nombre a secas
    (`"entity"`), que nunca coincidía con `"$en"`. El `insertText` del
    elemento ya era correcto (`"$entity"`); lo que fallaba era solo la
    label, que es la que se compara al filtrar. Ahora lleva el mismo
    prefijo que lo que realmente se va a reemplazar.

  Una pipeline de una sola etapa que falla también solía mostrar el mismo
  error exactamente dos veces — una en la propia tarjeta de la etapa que
  falla, otra más en un resumen a nivel de pestaña bajo la lista de
  etapas, ya que en una pipeline de una etapa esa única etapa es también
  la *última*. Ese resumen existe para cuando la columna de salida por
  etapa está oculta y ninguna tarjeta muestra nada en absoluto; simplemente
  no estaba condicionado a eso, así que saltaba incluso cuando la tarjeta
  justo encima ya decía lo mismo.

- **Una cinta de color en el chrome de cada ventana en cuanto hay más de una abierta, que indica de cuál se trata.** "New window", una pestaña separada y la ventana de Pulse se veían idénticas desde fuera — mismo título, todo igual — así que con varias abiertas a la vez no había forma de distinguir "esta es mi sesión principal" de "esta es el duplicado que abrí sin querer" salvo cerrarlas una a una. Cada ventana deriva ahora un tono de su propia etiqueta de Tauri y muestra una cinta con un punto de acento de ese color, el tipo de ventana ("Main window" / "New window" / "Floating tab" / "Pulse panel") y cuántas ventanas hay abiertas en total. La cinta desaparece en cuanto queda una sola ventana — todo el problema es distinguir ventanas entre sí, y eso deja de ser un problema cuando no hay nada con lo que confundirlas.

  La etiqueta de la ventana principal es la cadena fija `"main"`, así que siempre obtiene el mismo tono sesión tras sesión; cualquier otra ventana recibe un UUID nuevo al crearse, así que en la práctica los duplicados caen en su propio color sin nada guardado que mantener sincronizado. El recuento de ventanas viene directamente del propio registro de ventanas de Tauri (`getAllWindows()`), mantenido al día entre ventanas mediante un nuevo broadcast `huginndb://window-list-changed` emitido tanto al crear como al destruir una ventana — un broadcast de verdad, no un `emit_to` a una sola ventana, ya que la cinta de cada ventana necesita el total, no solo los cambios que ella misma provocó.

- **"Open in new window" en el menú contextual de una conexión.** Clic
  derecho sobre una conexión en el árbol y se abre en su propia ventana, ya
  conectada — el gesto que la CLI ya podía expresar (`--connect-profile`
  en un segundo lanzamiento) pero sin forma de llegar a él desde la
  interfaz. Se ofrece tanto si la conexión está activa como si no; el caso
  desconectado es el principal ("abrir este servidor en su propia ventana
  sin tocar la que ya tengo"), y hasta ahora esa rama del menú solo
  ofrecía "Connect".

  **No se abre un segundo pool.** `AppState` es por proceso y se comparte
  entre ventanas, y el retorno anticipado de `connect_inner` ya gestiona
  que una segunda ventana se conecte a un perfil que la primera tiene
  abierto — así que no hay una segunda reserva de endpoint ni un segundo
  túnel SSH. Cada ventana sigue listando como activo solo lo que ella
  misma abrió, lo cual es deliberado (issue #50).

  Dos comportamientos heredados que conviene conocer, ninguno nuevo:
  desconectar desde cualquier ventana cierra el pool para todas ellas, y
  cerrar una ventana secundaria deja vivo hasta que la app termine un pool
  que solo ella había abierto. La vía de la CLI se ha comportado siempre
  así.

  Si el perfil no tiene contraseña en el keychain — un lanzamiento
  `ephemeral` desde la CLI, o una contraseña escrita en el diálogo solo
  para esta sesión — la nueva ventana se abre y falla al conectar, con el
  error en su panel Console. La entrada deliberadamente no está
  condicionada a tener un secreto guardado: el fallo es legible, y
  condicionarla ocultaría el caso mayoritario para ahorrarle el
  minoritario.

- **Tamaño en disco por base de datos en el árbol de esquema (#153).** El
  issue pedía una forma de ver cuánto espacio ocupan una base de datos y
  sus tablas. Media parte ya estaba construida y apagada: `TableInfo.size_bytes`
  llevaba mucho tiempo poblado por los cinco drivers y el árbol ya lo
  renderizaba, pero `ui.schemaTableMetric` se publicaba con `"none"` por
  defecto. Lo que faltaba de verdad era el nivel de base de datos —
  `DatabaseInfo` era literalmente `{ name }`.

  Un nuevo comando diferido `get_database_sizes` lo resuelve para los
  cinco drivers, y el badge aparece en el nodo de base de datos (y, en
  SQLite, en el nodo de esquema, que es el único nodo que tiene ese
  driver). **No** está plegado dentro de `list_databases`: en Postgres
  esto es `pg_database_size`, que no es una lectura de catálogo sino un
  recorrido del directorio de la base de datos llamando a `stat` por cada
  fichero — segundos en un servidor con diecinueve bases de datos grandes,
  en la ruta que expande una conexión, bajo un timeout de 20 s. Se pide
  cuando se renderiza un nodo de base de datos, una sola vez, y se limpia
  con "Refresh" junto con el resto del esquema.

  **Los cinco números no coinciden entre sí, y no pueden hacerlo.**
  Postgres cuenta el directorio entero, espacio libre incluido; MySQL suma
  `DATA_LENGTH + INDEX_LENGTH` y no puede ver el espacio libre en
  absoluto; SQLite multiplica el recuento de páginas, con la freelist
  dentro y el `-wal` fuera; MongoDB informa `sizeOnDisk`, que está
  *comprimido*; SQL Server suma los ficheros de datos asignados y excluye
  el log. Tampoco coincidirán con la suma de los badges por tabla. La
  fuente de cada driver está documentada donde se consulta.

  **Un motor que no responde no produce badge — nunca un `0`.** El caso
  sobre el que está construido esto es real: un MariaDB 11.4 con un login
  de bajo privilegio devuelve `NULL` para el agregado en un esquema con 31
  tablas, y renderizar eso como cero diría que los datos han desaparecido.

- **La métrica del árbol de esquema puede mostrar ambos números a la
  vez.** `ui.schemaTableMetric` gana `"both"`, que renderiza
  `12.1k · 4.3 MB`. La app ha tenido ambas cifras para todos los drivers
  desde que existe la métrica, y obligaba a elegir una.

- **El editor de estructura muestra el tamaño y el recuento de filas de la
  tabla.** Un chip junto al nombre de la tabla en modo edición, leído del
  `TableInfo` que el árbol ya tiene — sin consulta adicional.

- **`IN` / `NOT IN` se pueden construir a mano, y un chip de filtro es
  editable.** Los dos operadores ya funcionaban de punta a punta — el
  backend deduplica la lista, eleva un miembro `null` a su propia rama
  `IS NULL`, y la limita a 1000 valores — pero la única forma de conseguir
  uno era la acción "filtrar por las filas seleccionadas" de la grid. El
  filtro avanzado los retiraba de su lista de operadores y dejaba a un
  lado, sin tocar, cualquiera que le llegara, porque su fila de condición
  no tenía control para una lista de valores. Ahora sí lo tiene: un
  textarea de un valor por línea con una casilla **Include NULL**
  separada.

  La casilla es la parte que merece explicación. `NULL` como *token*
  mágico en la lista sería indistinguible de la cadena literal de cuatro
  caracteres `"NULL"`, que es un valor legal en una columna de texto y
  que entonces no habría forma de buscar. Separarlos refleja lo que el
  backend ya hace. El textarea divide por `\r?\n`, así que una columna
  pegada desde Excel no llega con un retorno de carro invisible pegado a
  cada valor.

  Como ahora toda forma de filtro tiene un control, el diálogo edita la
  lista de filtros completa y en orden en lugar de un subconjunto — lo
  cual es lo que convierte la posición de un chip de la toolbar en un
  índice de fila, y ese es todo el mecanismo detrás de la segunda mitad:
  **hacer clic en un chip abre el filtro avanzado desplazado hasta esa
  condición.** Sin ids, sin DTO nuevo, sin cambios en el backend.

- **Todos los operadores se ofrecen en todas las columnas.** Una columna
  numérica o de fecha perdía `contains`/`starts with`/`ends with` y una
  columna de texto perdía las comparaciones ordenadas, mientras que el
  backend no restringía ninguna de las dos. "El número de factura contiene
  4471" es algo que la gente pide, y el generador de SQL ya convierte la
  columna a texto para responderlo.

### Cambiado

- **`ui.schemaTableMetric` ahora usa `"size"` por defecto en lugar de
  `"none"`.** Este es el único cambio de esta versión que altera lo que
  alguien ve sin haberlo pedido, así que merece la pena ser claros sobre
  el trade-off: un número junto a cada tabla es ruido visual, y
  `"row-count"` es, discutiblemente, más útil en el día a día. Lo que
  decanta la balanza es que `"none"` nunca ahorraba nada — cada driver
  rellena `size_bytes` sea cual sea la preferencia, y en SQLite eso son N
  consultas `dbstat` que el backend ejecuta porque no puede ver la
  preferencia en absoluto. Así que el valor por defecto anterior pagaba
  el coste y ocultaba el resultado.

  Solo se mueven las instalaciones nuevas. `save_preferences` escribe la
  estructura entera, así que cualquiera que haya tocado alguna vez una
  sola preferencia ya tiene un valor explícito en disco.

### Corregido

- **Una coincidencia de texto contra un campo de MongoDB que no es string
  no coincidía con nada, en silencio.** `$regex` de BSON solo inspecciona
  strings, así que `contains` sobre un `long`, una fecha o un `ObjectId`
  devolvía cero filas — no un error, solo un resultado vacío que se lee
  como "aquí no hay nada". `db.entityLog.countDocuments({ts: {$regex:
  "1788"}})` responde 0 en una colección donde todo `ts` empieza por esos
  dígitos, y `{ts: {$gte: 1788422462450}}` responde 6. Los drivers SQL
  nunca tuvieron este punto ciego, porque su generador ya envuelve la
  columna en `CAST(col AS TEXT)` primero.

  `contains` / `not contains` / `starts with` / `ends with` ahora emiten
  dos ramas: el `$regex` plano, que sigue usando un índice sobre un campo
  de tipo string — el caso común, y la razón por la que no se sustituye
  sin más — y un `$expr` que convierte el campo a string en el servidor
  para cubrir todo lo demás. **La rama `$expr` no puede usar índice**, así
  que una coincidencia de texto sobre una colección grande degrada a un
  scan; ese es el coste de que el operador responda con la verdad en vez
  de devolver nada, y por eso el arreglo llegó antes de que esos
  operadores se ofrecieran en columnas numéricas, no después. Requiere
  MongoDB 4.2 (para `$regexMatch`), una versión menor por encima del
  mínimo propio del driver.

- **"Bulk update" ampliaba su propia condición sin avisar.** Abrirlo con
  un chip `IN (…)` activo descartaba ese filtro al sembrar la condición de
  coincidencia, convirtiendo una actualización acotada a cuarenta filas en
  una acotada a la tabla entera. La confirmación de "sin filtro" tampoco
  lo detectaba, ya que los demás filtros seguían ahí y la lista, por
  tanto, no estaba vacía. Ahora siembra cualquier forma de filtro.

- **El límite de 1000 valores en `IN` no se aplicaba en la vía de
  actualización.** `validate_filters` era privado de la vía de
  exploración, así que `apply_bulk_update` — que comparte ese mismo
  generador de filtros — aceptaba una lista sin límite, en el `WHERE` de
  un `UPDATE` en vez del de un `SELECT` paginado. El filtro avanzado ahora
  también bloquea Apply con un contador en rojo, en lugar de truncar la
  lista o dejar que la llamada falle después.

- **Abrir el filtro avanzado ya no degrada los filtros que contiene.** Una
  fila de condición solo puede llevar un valor como texto, así que pulsar
  Apply reescribía antes un `Int64` de MongoDB, un objeto JSON o un valor
  con un salto de línea como lo que produjera `String(value)`. Una fila
  que el usuario no ha tocado ahora devuelve su payload original intacto.
  Editar ese valor sigue retipándolo a partir del tipo de catálogo de la
  columna, lo cual está documentado donde vive la coerción.

- **`formatBytes` se paraba en GB, así que una base de datos de 5 TB se
  habría renderizado como "5120.0 GB".** Ahora llega hasta PB. Su bucle
  también usaba `n > 1024`, que imprimía exactamente 1024 bytes como
  "1024.0 B". Ninguno de los dos podía morder mientras el helper solo
  etiquetaba una tabla; ambos son alcanzables ahora con tamaños a nivel de
  base de datos.

## [1.21.0] — 2026-09-02

### Añadido

- **El conector se distribuye como un MCP Bundle (`.mcpb`), así que Claude
  Desktop lo instala en un clic.** Claude Desktop no tiene CLI, así que era el
  peor caso: abrir un fichero JSON a mano, pegar una ruta absoluta con las
  barras invertidas duplicadas, reiniciar la app. Cada versión adjunta ahora
  `huginndb-mcp-<versión>-win32.mcpb` (y uno `-linux`) junto a los
  instaladores; **Configuración → Extensiones** toma el fichero y hace el
  resto.

  Un bundle por plataforma, porque el contenido es un binario precompilado y
  un bundle único cargaría a cada instalación con arquitecturas que nunca va
  a ejecutar. El bundle lleva el sidecar pero deliberadamente **no** es
  autónomo: HuginnDB tiene que estar instalado en la misma máquina, ya que ahí
  es donde viven los perfiles de conexión y sus entradas del keychain. No
  declara ningún `user_config` — algo que solo es posible porque la
  exposición se movió dentro de la app antes en esta misma versión, así que
  no queda nada que un instalador de extensión tenga que preguntar.

  `mcpb/manifest.json` es la fuente y `scripts/build-mcpb.sh` ensambla el
  zip. Dos detalles de ese script son estructurales y no incidentales: la
  versión se lee de `package.json`, así que no es un quinto sitio donde
  actualizar el número en cada versión (RELEASING.md lista los cuatro que sí
  lo son), y el modo de cada entrada del zip se fija explícitamente, porque un
  zip lleva sus propios permisos y el valor por defecto pierde el bit de
  ejecución — la misma trampa que el `cp` del sidecar en el workflow de
  release, un nivel más abajo. Un test comprueba que la lista de herramientas
  del manifiesto es exactamente la que sirve el router, ya que nada más
  vincula los dos ficheros y un bundle que mienta sobre sus propias
  herramientas lo haría en silencio.

  También nuevo: `docs/MCPB_SUBMISSION.md`, el dossier que pide una solicitud
  de directorio — información básica del servidor, cómo levantar un entorno
  de revisión a partir de la muestra Chinook, prompts de ejemplo verificados
  contra un handshake MCP real en vez de imaginado, y una tabla que asocia
  cada requisito exigido con el sitio donde se cumple. Vive en el repositorio
  para que se mantenga alineado con el código en vez de ser un formulario que
  alguien rellenó una vez.

  También nuevo: `docs/PRIVACY.md`, la política que exige una solicitud de
  directorio MCPB y que el producto necesitaba de todos modos. Es corta
  porque hay poco que decir — HuginnDB no recopila nada, no tiene backend, y
  lo único que escribe el conector es un log de auditoría local — pero el
  párrafo que merece la pena leer es el del cliente de IA: los resultados de
  las consultas van a la aplicación que los pidió, y lo que *ella* haga con
  ellos lo rige su propia política, no la nuestra.

- **Configuración → MCP puede registrar el conector con Claude Code en un
  clic.** El último paso manual de la configuración era copiar una ruta
  absoluta del panel y pegarla en una terminal (o, peor, en un fichero JSON).
  El nuevo botón ejecuta exactamente el comando que el panel ya mostraba —
  `claude mcp add huginndb -s user -- <sidecar>` — y lo notifica en el propio
  panel. Pulsarlo dos veces es inofensivo: "ya estaba registrado" se informa
  como un estado, no como un fallo, porque eso es sencillamente lo que parece
  un segundo clic. Si el CLI `claude` no está en el `PATH`, lo dice y el
  comando copiable queda como alternativa, que es el caso habitual de quien
  solo usa Claude Desktop. Deshacer con `claude mcp remove huginndb`.

  Implementado sin `tauri-plugin-shell`. Ese plugin existe para que el
  *frontend* lance procesos, algo que este código no hace de todos modos —
  toda la E/S vive en comandos de Rust — así que habría añadido una
  dependencia y una superficie de capacidades sin aportar nada más;
  `is_mcp_sidecar_running` ya había resuelto lo mismo. La sutileza de Windows
  que explica por qué existe `find_in_path` en vez de un `Command::new("claude")`
  directo es que `CreateProcess` no aplica `PATHEXT`, así que `claude.cmd` le
  resulta invisible, y resolver el ejecutable nosotros mismos también permite
  que la ruta del sidecar viaje como una entrada normal de argv en vez de ir
  entrecomillada dentro de una cadena `cmd /C` — habitualmente contiene
  espacios.

- **Todas las herramientas MCP llevan ahora un título y anotaciones MCP.** El
  conector distribuía veinticuatro herramientas con solo una descripción, así
  que un cliente solo tenía el nombre para decidir cuánta fricción merecía
  cada llamada: `list_tables` recibía la misma desconfianza que
  `delete_rows`, y ese coste recaía entero sobre las diecisiete herramientas
  que solo leen. Ahora declaran `readOnlyHint`, y las siete de escritura
  declaran `destructiveHint`/`idempotentHint` — con `insert_row` y
  `create_index` marcadas como *aditivas* en vez de destructivas, algo que
  importa porque `destructiveHint` es `true` por defecto cuando está ausente.
  `openWorldHint` está fijado en todas (`false` en las dos que solo leen
  estado local: `list_connections` y `pulse_metrics`).

  `run_query` era la única herramienta que ninguna constante describía con
  honestidad, y el arreglo fue dejar de pedírselo: **leer y escribir son
  ahora dos herramientas.** `run_query` ejecuta sentencias de solo lectura y
  está anotada `readOnlyHint`; la nueva `run_write` ejecuta las que cambian
  algo y está anotada `destructiveHint`. Cada una rechaza el tráfico de la
  otra y nombra la herramienta correcta a usar — rechazar *lecturas* en
  `run_write` importa tanto como lo contrario, o un modelo enruta todo por la
  herramienta de escritura y la separación no sirve de nada. Ambas siguen
  pasando por el mismo ejecutor y la misma barrera de política, que sigue
  releyendo `mcp_write` de disco en cada llamada.

  Esa separación surgió de una idea que merece quedar registrada como
  trampa, porque a primera vista parece obviamente correcta: derivar la
  anotación de `run_query` a partir de las políticas de escritura de las
  conexiones expuestas en ese momento. Un cliente lee `tools/list` **una
  vez**, al arrancar, mientras que aquí cada decisión de política y de
  exposición se relee en cada llamada precisamente para que pueda cambiar con
  un cliente en marcha — así que una anotación derivada de una foto fija se
  quedaría obsoleta en la dirección *insegura* en el momento en que una
  conexión pasara a `data`, dejando a un cliente que auto-aprueba convencido
  de que no hacía falta confirmar una escritura. La barrera seguiría
  aguantando; lo que desaparecería es la confirmación que el usuario creía
  tener. Dos herramientas con anotaciones constantes no tienen ese fallo, y
  además consiguen algo que la herramienta única nunca podría: las reglas de
  permisos de un cliente se basan en el *nombre* de la herramienta, así que
  "deja pasar los SELECT, pregúntame por el resto" ahora es expresable.

  `--read-only` sigue siendo la única entrada que puede variar la superficie,
  porque es un argumento del proceso fijo durante toda la vida del sidecar:
  con él, las ocho herramientas de escritura se retiran de `tools/list`
  directamente en vez de quedarse para responder con un rechazo.
  `ToolRouter::call` también rechaza una ruta desactivada, así que es una
  barrera real y no un truco de presentación.

  Reforzado con tests en vez de por el compilador (`annotations` es opcional
  en `Tool`, así que una herramienta sin anotar compila igual y simplemente
  no le cuenta nada a los clientes): un test comprueba que todas tienen
  título, `readOnlyHint` y `openWorldHint`, otro que ninguna herramienta de
  escritura se declara de solo lectura y que las dos aditivas lo dicen
  explícitamente, y un tercero que `--read-only` de verdad retira las ocho de
  la superficie.

### Cambiado

- **La micro-tipografía densa está por fin en la escala para la que se creó.**
  286 sitios escribían `text-[10px]`, `text-[11px]` o `text-[9px]` a pelo, que es
  justo lo que los tokens `3xs`/`2xs` de la app vinieron a sustituir: esa
  migración solo había cubierto un tercio del camino. Los tamaños en píxeles no
  cambian, pero el interlineado queda fijado en vez de heredado, así que dos
  etiquetas del mismo tamaño puestas una al lado de otra por fin se alinean. Seis
  etiquetas estaban por debajo del suelo de legibilidad de 10px que la escala
  existe para imponer y se han subido a él.

- **Sesenta y nueve esquinas siguen ahora el radio del tema.** El `rounded` a
  secas de Tailwind son 4px fijos que quedan fuera de la escala de radios de la
  app, así que esas esquinas eran las únicas de toda la interfaz que nunca podían
  moverse con el tema: ahora son `rounded-sm` (6px), el primer escalón de la
  escala. Dos píxeles más redondeadas en esos sitios, y una cosa menos que deja
  de funcionar el día en que el radio de las esquinas sea algo configurable.

- **Un solo color de hover en vez de cinco.** Al pasar el puntero por una fila,
  un elemento de menú o un botón de barra, el tinte podía ser cualquiera de
  cinco intensidades —opaco en 29 sitios, y al 30%, 40%, 50% o 60% en otros 50—,
  así que el mismo gesto se leía distinto según el panel en el que estuvieras, y
  dos superficies contiguas podían discrepar. Ahora todas usan el color de hover
  del tema a plena intensidad. Vale la pena dejar dicho el razonamiento, porque
  es la regla de aquí en adelante: `--accent` *es* la superficie de hover, así
  que si el resultado se ve demasiado fuerte lo que hay que ajustar es ese token,
  no cincuenta puntos de uso. El fondo de la paleta de comandos coincide también
  con el del resto de modales, en vez de ser un 10% más claro.

- **Los indicadores de carga, las etiquetas de estado y los títulos de sección
  son tres primitivos compartidos en vez de tres costumbres.** El indicador de
  carga aparecía en 39 sitios con tres tamaños; los títulos de sección en 24,
  con cuatro grafías del mismo estilo de 10px en mayúsculas —dos de ellas
  discrepando incluso en el espaciado entre letras—; y las etiquetas de estado
  eran un componente privado más una treintena de spans a mano. Los títulos de
  sección que van dentro de un menú usan ahora una etiqueta de menú de verdad,
  que es lo que siempre quisieron ser. Se nota donde un título medía 11px: pasa
  a los 10px compartidos.

- **Los desplegables nativos son un único control, y el arreglo de tema que
  hay detrás existe una sola vez.** WebView2 pinta el popup de un `<select>`
  con el color de fondo del propio disparador, así que un disparador
  transparente abre un popup en claro del sistema por oscuro que sea el tema de
  la app. Los ocho selects nativos de la aplicación llevaban cada uno su copia
  de ese arreglo, con cuatro grafías distintas del cromo que lo rodea: un
  parche a un copiar-pegar de perderse. Ahora es incondicional y vive en el
  primitivo. De paso, los más densos pasan de 24px a los 28px compartidos.

- **Las casillas de verificación son ahora un único control.** Treinta y cinco
  eran inputs nativos escritos punto por punto, en cuatro tamaños, con el estado
  mixto («algunos seleccionados») cableado a mano mediante una ref en cuatro
  sitios y varias sin ningún estilo — así que el mismo control se pintaba en
  tres tamaños distintos y, hasta antes en esta misma versión, en dos colores
  distintos. Todas pasan por un solo primitivo. Se nota donde una casilla no
  tenía estilo: ahora coincide con el resto a 14px en azul de marca, y muestra
  anillo de foco, algo que las desnudas nunca hicieron.

- **Un botón que está trabajando ahora lo dice de forma coherente.** `Button`
  incorpora `loading`/`loadingLabel` y una prop `icon` para el icono inicial, y
  los quince pies de diálogo que montaban el estado de ocupado a mano —un
  `Loader2` como hijo con su propio `mr-1.5`, un `disabled` aparte y, en un
  caso, un spinner que solo aparecía cuando el botón *no* tenía etiqueta de
  ocupado— se lo delegan ahora al primitivo. Dos consecuencias visibles
  pequeñas: la separación entre el icono de un botón y su texto sale del `gap-2`
  compartido en vez de un margen por punto de uso, así que es uniforme (y 2px
  mayor en esos quince sitios); y un botón de confirmación que dice
  «Eliminando…» ahora gira mientras lo hace, donde antes mostraba solo el texto.

- **`DialogContent` usa `max-w-md` por defecto, y la prop de tamaño se llama
  `size` en todos los primitivos.** De los 31 diálogos que sobrescribían el
  ancho del modal, 15 pedían `max-w-md` y solo 3 querían el `max-w-lg` que
  shadcn trae por defecto: el valor por defecto simplemente estaba mal elegido
  para una herramienta de escritorio densa. Corregirlo borró 15 `className` y
  hizo innecesaria una variante `size` en Dialog, porque lo que queda son casos
  únicos de verdad que se leen bien como sobrescrituras explícitas. Aparte, la
  variante de densidad de `Input` se llamaba `inputSize` para esquivar el
  atributo HTML nativo `size` (ancho en caracteres) — pero su tipo de props ya
  hace `Omit` de ese atributo, así que el rodeo había sobrevivido a su motivo y
  dejaba la librería con dos nombres para un mismo concepto.

- **Las conexiones expuestas al conector MCP ahora se eligen desde la propia
  app, y las herramientas aceptan el *nombre* de una conexión.** Dos mitades
  de la misma queja: la configuración del cliente llevaba un uuid interno que
  el usuario nunca eligió y no debería haber tenido que ver.

  Qué conexiones podía alcanzar el conector vivía *solo* en la configuración
  propia del cliente MCP, como `--connections <uuid>,<uuid>`. Añadir una
  conexión implicaba entonces crearla en la app, buscar su `id` en
  `profiles.json`, editar a mano `~/.claude.json` (y el de Cursor, y el de
  Codex, …), y reiniciar cada cliente — y un perfil borrado más tarde dejaba
  un id muerto en cada uno de esos ficheros sin nada que lo detectara. La
  asimetría era la pista: `mcp_write`, la mitad *más* relevante para la
  seguridad, ya vivía en el perfil y ya se releía de disco en cada intento de
  escritura, así que el interruptor más grueso era el que había quedado fijo.
  La exposición es ahora `ConnectionProfile::mcp_exposed`, activable en
  **Configuración → MCP** — que hasta ahora podía ofrecer esa elección pero no
  aplicarla, ya que sus casillas solo alimentaban el fragmento generado — y se
  relee en cada llamada, así que exponer una conexión más surte efecto sin
  reiniciar el cliente de IA. Los fragmentos generados ya no llevan ningún id
  y son iguales en cualquier máquina.

  `--connections` sigue funcionando y sigue ganando cuando se pasa, fijando un
  cliente a un conjunto concreto durante toda la vida del proceso (ver *Fijar
  un cliente a un conjunto concreto* en `docs/MCP.md`); cualquier
  configuración anterior a la 1.21 sigue comportándose exactamente igual. Al
  actualizar no queda nada expuesto: `mcp_exposed` vale `false` por defecto en
  todos los perfiles existentes, así que un cliente lanzado sin el flag
  arranca sin nada que alcanzar hasta que el usuario marque algo.

  La exposición es estrictamente local. `merge_into` la conserva en ambos
  sentidos durante una sincronización de origen compartido (un publicador no
  puede exponer una base de datos en tu máquina, y una actualización no puede
  quitarle acceso a un cliente en mitad de una sesión), y `apply_profile_imports`
  la limpia, así que importar el paquete de un compañero para echarle un
  vistazo nunca le da acceso en vivo a tus clientes de IA. La política de
  escritura viaja intacta — no concede nada mientras la conexión es
  inalcanzable.

  Todas las herramientas aceptan ahora el **nombre** de la conexión tal como
  aparece en HuginnDB, no solo el id del perfil (`resolve_connection`,
  `src-tauri/src/mcp/mod.rs`). `list_connections` ya informaba de ambos, y el
  modelo seguía obligado a copiar el uuid en cada llamada siguiente. Un id
  sigue ganando sobre un nombre que coincida, la resolución solo cubre las
  conexiones expuestas, un nombre ambiguo se rechaza listando los candidatos
  en vez de adivinar, y una referencia a una conexión real pero no expuesta
  ahora lo dice exactamente así — con el arreglo que corresponde según cómo
  se arrancó el servidor — en vez de "conexión desconocida".

  `docs/MCP.md` abre con un **Inicio rápido** — cuatro pasos, sin terminal —
  y una nota "vienes de una configuración anterior a la 1.21", porque el
  hábito antiguo (editar el JSON del cliente, pegar un uuid) todavía
  *funciona* y de otro modo nunca le diría a nadie que ya no hace falta.
  Ambas son secciones `##`, así que el visor de documentación integrado en la
  app las renderiza como páginas propias en los dos idiomas sin coste
  adicional.

  Bajo los pools compartidos la app vuelve a comprobar la exposición por sí
  misma en cada petición puenteada en vez de fiarse de la lista que el
  sidecar declaró en el handshake (`Exposure` en `src-tauri/src/bridge/server.rs`);
  un handshake ocurre una vez y un cliente mantiene su sidecar durante días,
  así que una foto fija habría reproducido justo la obsolescencia que este
  cambio elimina. El frame `Hello` incorporó un flag aditivo `deferExposure`
  sin subir de versión el protocolo — una app anterior a él aplica la foto
  fija que el sidecar sigue enviando, que es el comportamiento antiguo y no
  un rechazo, y un rechazo es el único resultado del que el sidecar no puede
  degradarse con elegancia.

### Corregido

- **Los tooltips se recortaban y quedaban tapados cerca del borde de un panel.**
  El tooltip con estilo se dibujaba en su sitio dentro de la página en vez de por
  encima, así que un contenedor con scroll lo cortaba y cualquier cosa apilada
  sobre el panel lo cubría — se veía en el botón de «desconectar todo» del panel
  de conexiones, cuyo tooltip aparecía partido por detrás de la barra de título.
  Ahora se dibuja por encima de todo, como el resto de superficies flotantes de
  la app, y guarda un margen con los bordes de la ventana para voltearse al otro
  lado en vez de quedarse pegado a ellos.

- **Los botones de icono mostraban el tooltip del sistema operativo, no el de la
  app.** Veintinueve de ellos —los controles de zoom del pie del grid, la barra de
  la consola, las acciones de fila de las consultas guardadas, el exportar y
  borrar del panel de apariencia y más— eran `Button` con un `title` nativo, así
  que al pasar el puntero salía un tooltip sin estilo y con el retardo del
  sistema, justo al lado de botones ya migrados que mostraban el de la app. Todos
  usan ya el tooltip con estilo. Los cinco cuyo aspecto tenía que mantenerse (una
  flecha de transferencia con borde, un botón de filtro que lleva un contador)
  conservan su botón y han ganado el tooltip con estilo alrededor.

- **Costaba saber qué campo o control tenías enfocado.** Dieciséis sitios
  dibujaban el foco como `ring-1 ring-ring`: un pelo de un píxel en el color de
  anillo del tema que, a ese grosor, es casi invisible en cualquiera de los dos
  temas. Nunca fue una decisión, sino la forma que tenía el foco antes del
  rediseño visual, y seguía viva porque no había de dónde tomar el tratamiento
  actual: los nueve campos densos de las celdas del grid y los selectores de
  tipo usan ahora el mismo lenguaje —el borde se vuelve azul de marca más un
  halo tenue— que cualquier `Input`, y los siete controles de la barra de estado
  y del conmutador usan el anillo que el control segmentado ya tenía. El campo
  de celda del editor de estructura entra aquí: era el único campo de la app que
  anulaba el foco del primitivo con un borde gris y un pelo, así que saber qué
  celda estabas editando costaba de verdad. Ya no anula nada.

- **Tres errores de token de tema en el cromo compartido: casillas, enlaces en
  línea y todas las sombras escritas a mano.** Los tres vienen del mismo sitio
  —un punto de uso que escribe él mismo un color en vez de tomar el que el
  sistema de diseño ya tenía— y los tres pasaban desapercibidos hasta poner dos
  superficies una al lado de la otra.

  Doce casillas usaban `accent-primary`, que no es el azul que nadie esperaba:
  `--primary` es casi negro en los temas claros y casi blanco en los oscuros
  (`index.css`), mientras que `--brand` es el único color saturado que la app
  puede gastar en affordances que significan «haz esto». Así que el mismo
  control se pintaba gris en doce sitios y azul de marca en otros veinte, a
  veces en la misma pantalla. Ahora todas las casillas toman `accent-brand`.
  Cinco enlaces en línea tenían el mismo error con `text-primary`, y
  `Button variant="link"` ya usaba `text-brand` — así que esos cinco
  contradecían a su propio primitivo.

  Nueve superficies dibujaban una sombra cruda de Tailwind (`shadow-sm` …
  `shadow-2xl`) en lugar de la escala `shadow-elevation-1..4`, tres de ellas
  dentro de `components/ui/`. Y no es solo inconsistencia: las sombras de
  Tailwind son un negro fijo, mientras que la escala de elevación mezcla
  `--foreground`, así que una sombra cruda bajo un panel oscuro es un manchón
  negro en vez de la elevación que pretendía ser. Los paneles flotantes están
  ahora en `elevation-3` (igual que el desplegable, el menú contextual y el
  select, que ya lo hacían) y las superficies modales en `elevation-4` (igual
  que `DialogContent`).

- **Ocultar una conexión en el selector de un entorno sincronizado no se
  mantenía — la siguiente sincronización del origen la volvía a mostrar sin
  avisar.** `visible_connections` (`LaunchState`, el mismo filtro "al estilo
  DataGrip" que el #107 añadió para un entorno normal) era un único campo
  cumpliendo dos funciones incompatibles en un entorno espejado:
  `sync_environment_bundles` lo trataba como la membership real de conexiones
  del origen y lo sobrescribía entero en cada sincronización, mientras que el
  árbol de conexiones trataba ese mismo campo como la elección del usuario de
  qué ocultar o mostrar. Los dos solo coincidían por casualidad, hasta que la
  siguiente sincronización programada (o un "Sincronizar ahora" manual)
  devolvía el filtro a "mostrar todo lo que publica el origen".

  `Environment` incorpora un quinto override local, `local_visible_connections`,
  junto al cuarteto ya existente `local_name`/`local_color`/`local_icon`/`local_theme_id`
  — misma forma: `Some(lista)` gana sobre el valor sincronizado y `None`
  significa "seguir al origen". `sync_environment_bundles` sigue sobrescribiendo
  `launch.visible_connections` con la membership real del paquete (esa parte
  nunca fue el problema — una conexión recién compartida tiene que seguir
  apareciendo sola), pero ya nada lee ese campo directamente:
  `Environment::effective_visible_connections` resuelve primero el override, y
  tanto `get_launch_state` como `list_environments` devuelven el valor ya
  resuelto. `save_launch_state` desvía el filtro que llega hacia el override en
  vez de hacia el campo sincronizado siempre que el entorno activo esté
  espejado desde un origen, de modo que la siguiente sincronización tenga la
  membership real con la que comparar en vez del último subconjunto elegido
  por el usuario. Volver a marcar "mostrar todo" también limpia el override,
  que es exactamente "volver a seguir al origen" — una sincronización nunca
  publica una membership más estrecha que el paquete completo, así que nunca
  hubo un caso en el que "sin override" tuviera que significar otra cosa.

### Añadido

- **Insertar una etapa del pipeline en cualquier posición, no solo al
  final.** El orden de un pipeline es su significado, así que la edición más
  común era la incómoda: darse cuenta de que un `$match` va *antes* del
  `$lookup` ya escrito significaba añadir una etapa al final de la lista y
  arrastrarla hacia arriba pasando por todo lo demás. Cada tarjeta de etapa
  ofrece ahora su propio "insertar arriba", que es lo que alcanza cualquier
  hueco del pipeline incluido el primero — la posición que más importa, ya
  que filtrar pronto es lo más habitual que un pipeline quiere poner delante
  de lo que ya tiene. Vive en la cabecera de la tarjeta junto al borrar, en
  vez de como una zona sensible al hover en el hueco entre tarjetas, porque
  ese hueco ya pertenece al indicador de soltar del arrastrar-y-soltar.

- **Duplicar una etapa del pipeline.** El complemento del insertar arriba: un
  `$match` ya afinado suele ser el punto de partida más rápido para el
  siguiente, y volver a escribirlo era la única forma de conseguir un
  segundo. La copia aterriza justo después de su origen — duplicar significa
  "otro como este", una relación distinta con la tarjeta que la de un
  insertar, que significa "haz sitio aquí". Su cuerpo y su flag de activada
  se copian tal cual, así que duplicar una etapa desactivada no activa la
  copia en silencio ni la mete en la siguiente vista previa; su estado de
  colapso se reinicia, porque una tarjeta recién creada es una que estás a
  punto de editar.

### Cambiado

- **Las tres formas de añadir datos en MongoDB se juntaron en un único botón
  Insertar desplegable.** La fila de borrador en línea, el editor de
  documentos libre y "Importar JSON" eran tres controles de barra separados
  para una misma intención, en una barra que ya colapsa en un menú de
  desbordamiento a anchos normales. El cuerpo del botón sigue realizando la
  acción "insertar" simple con un solo clic — la acción más frecuente del
  grid, y una sin atajo de teclado al que recurrir — y solo su flecha abre el
  menú con las otras dos. En los cuatro motores SQL, que no tienen
  alternativas, se queda exactamente como el botón simple que siempre fue; un
  control desplegable que ofrece una sola opción sería peor que ningún
  desplegable.

- **Los controles de ancho de columna se movieron al pie del grid, junto a
  los botones de zoom de fila.** Antes vivían en la barra de herramientas de
  la cabecera, lo que dividía las dos mitades de una misma pregunta —qué
  anchas son las columnas, qué altas son las filas— entre los dos extremos
  opuestos del grid. También descarga una cabecera que iba sobrada: en
  MongoDB llevaba diez controles y colapsaba en su menú de desbordamiento a
  anchos de panel normales, y entre este movimiento y el botón Insertar
  desplegable de arriba se quita cuatro. Un separador distingue ahora los dos
  grupos del pie para que se lean como dos grupos y no como una sola fila de
  cuatro botones.

### Corregido

- **El total de filas de una colección de MongoDB quedaba desactualizado
  tras cualquier escritura, y un fallo al cargar la lista de campos era
  invisible y permanente.** Actualizar —el botón, F5, o el refetch tras un
  borrar/insertar/importar— nunca volvía a contar las filas, porque el efecto
  que cuenta está indexado por el predicado de la consulta y nada de añadir
  o quitar filas cambia eso, así que el pie seguía mostrando el último total
  calculado. Por separado, cuando fallaba la inferencia de los campos de la
  colección, la pestaña registraba el error pero nunca lo mostraba ni
  ofrecía reintentar — el único síntoma visible era el diálogo de filtro
  avanzado abriéndose con un formulario vacío, ya que se construye
  enteramente a partir de esa lista de campos. Un único `reload` sostiene
  ahora por igual actualizar, F5, borrar, insertar e importar, y la pestaña
  muestra el error de inferencia —o un indicador de carga mientras está en
  curso— en vez de quedarse muda en silencio.

- **Inferir los campos de una colección grande de MongoDB podía colgarse en
  vez de fallar, y un recuento filtrado podía tardar minutos.** El camino
  rápido de `$sample` necesita una condición previa del motor de
  almacenamiento que una colección de series temporales nunca puede cumplir
  en sus buckets de respaldo, así que la inferencia sobre una de ellas caía
  en leer la colección entera y ordenarla por una clave aleatoria — algo que
  no termina con decenas de millones de documentos, y corría sin ningún
  timeout. Una comprobación del catálogo salta ahora directamente a un
  barrido acotado `find().limit()` por ambos extremos para una colección que
  no puede tomar el camino rápido, y un `$sample` lento en cualquier otro
  caso pasa a ese mismo barrido tras 2 segundos. Un recuento contra un
  filtro —un barrido completo de la colección sin índice que lo responda—
  está ahora limitado a 10 segundos en vez de correr sin límite mientras
  retiene una conexión del pool; al agotarse el tiempo el grid recurre a
  mostrar el rango de página sin un total, exactamente como ya hace con
  cualquier otro recuento fallido.

- **El indicador de carga del botón de filtro avanzado de MongoDB nunca se
  detenía.** Un array de dependencias de `useMemo` desactualizado
  —introducido junto al propio indicador— dejaba la barra de herramientas
  pintando el JSX del primer render, de antes de que la lista de campos
  cargara, para siempre. Reproducido en una colección de 20.000 documentos
  donde el muestreo es instantáneo, lo que apuntó al memo y no a nada del
  servidor.

- **Cambiar el grid a vista de lista se pausaba en una página grande, y el
  scroll nunca se sentía bien después.** La vista de tabla está virtualizada
  desde que se escribió; la vista de lista —una línea por campo y
  documento— nunca lo estuvo, y en el tamaño de página más grande son miles
  de nodos del DOM construidos en un único commit síncrono. Ahora está
  virtualizada, midiendo la altura real de cada tarjeta de forma dinámica en
  vez de asumir una altura de fila fija: la altura de un documento es su
  número de campos, que varía de un documento a otro y cambia al colapsar un
  valor anidado.

- **El botón "∅" del editor de celda en línea —un clic perdido de borrar un
  valor, sin confirmación— ha desaparecido.** Ponerlo a `NULL` mientras se
  editaba en línea estaba justo al lado del cursor, y a diferencia del resto
  de acciones destructivas del grid se aplicaba en el instante del clic.
  `NULL` sigue siendo alcanzable desde el menú contextual de la fila —un
  segundo paso deliberado en vez de una tecla junto a donde estás escribiendo.
  El botón de expandir que queda ahora muestra el tooltip con estilo de la
  app en vez del del sistema operativo, lo que además deja `CellInput.tsx`
  a cero en la ratchet de deuda de tooltips nativos; sigue siendo un botón
  hecho a mano en vez del primitivo `IconButton` compartido, porque la forma
  más pequeña de ese primitivo es un cuadrado fijo de 24px —exactamente el
  alto del propio campo—, sin margen para respirar dentro de su borde. El
  botón "∅" gemelo de la vista de lista de MongoDB (`DocumentListView`)
  desaparece por el mismo motivo.

- **Una celda en edición en línea mostraba dos cuadrados azules anidados.**
  El anillo `ring-2 ring-inset ring-brand` de la celda activa por teclado
  seguía encendido mientras `CellInput` (o el `<select>` de una columna BIT)
  dibujaba su propio borde azul de marca más halo justo encima, dentro de la
  misma celda —dos contornos de foco compitiendo por un mismo campo. El
  anillo exterior ahora se suprime justo en la celda que se está editando en
  línea, ya que el propio campo ya lo indica.

- **El botón de "ver el valor completo" de una celda seleccionada-pero-sin-
  editar pintaba un parche visiblemente distinto sobre la celda.** Seleccionar
  una celda (sin entrar en edición) muestra un pequeño botón para ver el valor
  completo (issue #78); pintaba un `bg-background` plano detrás de sí mismo
  para que su posicionamiento `sticky` tuviera una superficie opaca sobre la
  que apoyarse, y ese color plano nunca seguía el propio relleno de la celda
  —seleccionada, con la franja de cebra, en hover—, así que se veía como un
  rectángulo de un tono distinto sobre la celda que lo rodeaba. Ahora es
  transparente, la misma clase de costura que ya se había arreglado en el
  botón `sticky` de `CellInput`; el compromiso aceptado es que, al hacer
  scroll horizontal en una columna muy ancha con la celda a la vez sticky y
  seleccionada, se puede ver el texto pasando por debajo.

## [1.20.0] — 2026-08-31

### Añadido

- **Orígenes compartidos: personalización cosmética local para un entorno
  espejado, y edición en el sitio para el publicador.** Dos fricciones de
  larga data en el flujo de orígenes compartidos (#108), ambas reportadas
  tras un uso real y no encontradas por inspección.

  El `name`/`color`/`icon`/tema de un entorno espejado se sobrescribían sin
  excepción en cada sincronización — el mismo trato de "solo lectura,
  liberado solo vía adopt/retire" que su membership de conexiones sí
  necesita de verdad, aplicado a campos que solo describen cómo se ve el
  entorno en *esta* pantalla. Un usuario a quien no le gustara el icono
  elegido por un compañero no tenía forma de cambiarlo que sobreviviera a la
  siguiente sincronización. `Environment` ahora lleva cuatro campos
  acompañantes de solo esta máquina
  (`local_name`/`local_color`/`local_icon`/`local_theme_id`,
  `src-tauri/src/tab_state.rs`) que `sync_environment_bundles` nunca toca y
  que nunca viajan por la exportación ni por el documento del origen — el
  mismo razonamiento de "decisión local que el publicador no puede conocer"
  que `merge_into` ya aplica al `mcp_write`/`pulse_enabled` de un perfil de
  conexión (gotcha #56), extendido un nivel más arriba. `EnvironmentEditorDialog`
  escribe en ellos (vía el nuevo comando `set_environment_local_overrides`)
  en vez de en los campos sincronizados cuando el entorno que se edita está
  espejado, con una nota en lenguaje llano explicando que el cambio es
  local, y una acción "volver a seguir al origen" para descartar el
  override. Al desvincularse del origen (`adopt_environment`) el override
  fijado se pliega sobre el campo público, que pasa a ser la verdad, en vez
  de dejar dos copias sueltas.

  Por otro lado: corregir un valor mal publicado a través de un origen
  compartido (una contraseña desactualizada, sobre todo) exigía duplicar la
  conexión bajo un id nuevo, editar la copia, volver a publicarla, y luego
  limpiar a mano el original ya huérfano una vez una sincronización
  posterior lo marcaba `vanished` — dos reinicios de la app y una fila
  suelta si se saltaba algún paso. Resultó que el backend nunca imponía de
  verdad el solo-lectura en un perfil vinculado a un origen —
  `save_profile` no comprueba `origin_id` en absoluto, y ya escribe la
  entrada de keychain de la que el modo de secreto `fromKeychain` de una
  republicación se resuelve — el bloqueo era puramente que
  `ConnectionDialog` se negaba a llamarlo. La única excepción permitida
  ahora es el propio publicador del origen: `canEditInPlace`
  (`fromOrigin && originIsPublished`) le permite corregir el perfil —
  contraseña incluida — en el mismo diálogo y el mismo id, sin duplicado ni
  huérfano, y volver a publicarlo desde el editor de orígenes ya existente
  cuando esté listo. Publicar, adoptar o retirar desde ese editor ahora
  también dispara un `useOriginSync.syncAll()` completo en el acto, así que
  el `profiles.json` y el estado `vanished` de esta misma máquina se ponen
  al día de inmediato en vez de esperar al siguiente arranque o a un
  "Sincronizar ahora" pulsado a mano.

- **Pulse llega al conector MCP — siete herramientas de solo lectura, que
  cierran la funcionalidad.** `pulse_health`, `pulse_metrics`,
  `pulse_top_queries`, `pulse_explain`, `pulse_storage`, `pulse_sessions`,
  `pulse_index_usage`: las mismas seis vistas que el panel de escritorio ya
  mostraba, más el histórico en disco, ahora responderibles por un cliente
  de IA contra cualquier conexión a la que tenga permitido llegar — no hace
  falta tener abierta ninguna interfaz de la propia app para que un cliente
  pregunte "cómo está este servidor" o "cuál es la sentencia más lenta de
  esta conexión".

  Cada herramienta despacha directamente a la misma función `_inner` que ya
  llama su comando de Tauri — `pulse_health` a `pulse_health_inner`,
  `pulse_explain` a `pulse_explain_inner`, y así con el resto — a través del
  mismo abanico de `BridgeRequest` que ya usa cualquier otra herramienta de
  solo lectura, que es lo que hace que la protección de `pulse_explain`
  (solo lectura, una única sentencia, que no sea ella misma
  `EXPLAIN`/`ANALYZE`) se aplique aquí sin código nuevo: ya vivía en
  `commands::pulse::validate_explain_target`, escrita la primera vez que la
  llegada de esta herramienta era todavía "aún no" en vez de duplicada ahora
  que ya lo es.

  `pulse_metrics` es la única herramienta sin nada a lo que despachar en el
  lado de Tauri bajo ese nombre — lee `pulse.db` directamente, a través de
  un nuevo `pulse_metrics_inner` extraído del comando `pulse_history` ya
  existente, de forma que los dos nombres comparten una sola
  implementación. No necesita ningún pool en vivo, lo cual importa para
  cómo se comporta en modo sidecar independiente: sin la app de escritorio
  corriendo, el propio modo de journal WAL de `pulse.db` es lo que permite
  al sidecar abrir el mismo fichero que abriría la app y ejecutar lecturas
  contra él de forma concurrente con el muestreador de la app, en vez de
  necesitar un protocolo propio para pedirle la respuesta a la app.

  Las siete están conectadas de forma exhaustiva por cada match que
  gobierna `BridgeRequest` — `is_mutating` (todas `false`), `label`,
  `connection_id_of` — así que el compilador detecta un olvido en vez de
  que una petición caiga en silencio en el `None`/`_ =>` por defecto que sí
  arriesga una variante de escritura (ver la gotcha #49 del `CLAUDE.md`).
  Ninguna de las siete toca `bridged_connection_id` ni ninguno de los dos
  matches de policy: las lecturas no llevan `policy_id` y no lo necesitan,
  la misma forma que ya tiene cualquier herramienta de solo lectura
  anterior.

- **Pulse tiene memoria: `pulse.db`, un muestreador de 60 segundos, retención,
  y un panel Settings → Pulse para activarlo.** Cada vista de Pulse anterior
  respondía "cómo está este servidor ahora mismo" y olvidaba la respuesta en
  cuanto se cerraba la ventana. Esta es la última pieza que le faltaba a la
  promesa de rendimiento de HuginnDB: ahora se le puede preguntar a Pulse
  "cómo se veía esto la semana pasada", y responder eso con honestidad
  significó diseñar el coste en disco primero, no añadirlo después.

  El muestreo es opt-in **por conexión** (`pulse_enabled` en el perfil,
  desactivado por defecto, preservado a través de una sincronización de
  origen compartido igual que ya hace `mcp_write`) y lee solo lo que un tick
  de 60 segundos necesita en un único viaje de ida y vuelta — `SHOW GLOBAL
  STATUS` en MySQL, `serverStatus` en MongoDB — nunca la segunda lectura,
  casi estática (`SHOW GLOBAL VARIABLES`; el nivel de profiling), que
  `health()` del panel en vivo sí hace. Que un tick falle para una conexión
  (un servidor caído, un privilegio revocado) le cuesta a esa conexión un
  hueco de un minuto, nunca la muestra del resto de la flota. `sampleWhenMinimized`
  (activado por defecto) cambia esa promesa por coste cero en el servidor
  siempre que HuginnDB mismo no está en pantalla.

  El almacén es el único fichero de estado de esta app que no es JSON.
  Reescribir un blob entero de forma atómica en cada tick — el patrón de
  `state_file.rs` para todo lo demás — es exactamente la amplificación de
  escritura que una serie temporal existe para evitar, así que `pulse.db` es
  en su lugar una pequeña base de datos SQLite (WAL, una única tabla
  `samples(connection_id, ts_ms, metric, value)`), abierta de forma perezosa
  en el primer uso para que una instalación en la que nadie ha activado Pulse
  en ninguna conexión nunca cree el fichero. `state_file::path` sigue
  resolviendo *dónde* vive — esa función solo resolvía una ruta y creaba el
  directorio padre, nunca asumió JSON — lo que hace que el aislamiento de
  estado de la build canary (gotcha #26) se aplique aquí gratis. Los
  contadores se guardan en crudo, la misma regla que ya sigue la serie en
  memoria en vivo: derivar una tasa necesita dos muestras y el hueco entre
  ellas, y una tasa pre-derivada haría indistinguible un reinicio del
  servidor de una caída real.

  La retención es una escalera, ejecutada en el mismo tick justo después de
  escribir: resolución completa de 60 segundos durante 48 horas, reducida a
  un punto cada 5 minutos hasta la ventana de retención (30 días por
  defecto), y borrada del todo a partir de ahí. Un límite blando
  `maxDiskMb` (20 MB por defecto, `0` lo desactiva) descarta la décima parte
  más antigua de lo que queda si el fichero sigue por encima del
  presupuesto después de eso — una válvula de seguridad tosca para una
  flota de conexiones para la que nadie dimensionó la ventana de retención,
  no lo que gobierna el uso de disco día a día.

  La ventana ampliada gana una sexta entrada en el panel lateral,
  Retrospectiva: dos gráficas (consultas/s, presión de conexiones) sobre un
  rango de 24h/7d/30d, reutilizando el `Sparkline` dibujado a mano del panel
  y un nuevo `seriesFromHistory` que comparte con la serie en vivo la
  aritmética de `rateBetween` a prueba de reinicios e intervalos
  irregulares, en vez de rederivarla. El histórico de aciertos de caché
  deliberadamente no es una de las dos: necesita sus dos contadores
  subyacentes alineados punto a punto, y el histórico reducido no garantiza
  mantener esa alineación limpia.

  Settings → Pulse es nuevo: los propios ajustes del muestreador (intervalo
  de muestreo, retención, límite de disco, muestrear minimizada) encima de
  un selector de conexiones que refleja el árbol de `Settings → MCP` — el
  mismo agrupamiento por procedencia vía `buildRailSections`, el mismo
  razonamiento para saltarse la excepción de solo-lectura de origen
  compartido (el opt-in es una decisión local de recursos, no algo sobre lo
  que un publicador a dos máquinas de distancia tenga voz). A diferencia del
  selector de MCP, la casilla *es* el ajuste persistido en vez de una
  selección efímera para construir un snippet, así que marcarla escribe
  directamente a través de un nuevo comando `set_pulse_enabled` — la misma
  forma de "un campo, no el perfil entero" que ya usa `set_mcp_write_policy`.

  Nuevo: `pulse::store::PulseStore`, `pulse::sampler`, `prefs::PulsePrefs`,
  `ConnectionProfile::pulse_enabled`, `db::{mysql,mongo}::pulse::sample`, los
  comandos `pulse_history`/`set_pulse_enabled`, `seriesFromHistory`, y los
  componentes de ajustes `PulseSection`/`PulseConnectionTree`.

- **Pulse gana Sesiones e Índices — las dos entradas del panel lateral que le
  faltaban a la ventana ampliada.** Las dos son lecturas a demanda y de
  actualización manual: a diferencia de la tabla de digests y el ranking de
  almacenamiento, una lista de sesiones con quince minutos de antigüedad no
  es solo "algo desfasada", es activamente engañosa — así que ninguna de las
  dos vistas se sondea sola: cada una tiene su propio botón de actualizar, y
  la lectura se dispara una vez al abrir esa entrada del panel.

  Sesiones lee `SHOW FULL PROCESSLIST` en MySQL — la misma sentencia que
  ejecuta cualquier cliente `mysql`, y a diferencia de
  `information_schema.PROCESSLIST` nunca queda desactivada por
  `show_compatibility_56` en un servidor que ya ha dejado eso atrás — y la
  forma en pipeline de agregación de `currentOp` en MongoDB. Los dos motores
  mantienen su propio vocabulario en vez de traducirse a uno compartido: las
  columnas `Command`/`State` de MySQL y el campo `op` de MongoDB junto con el
  estado derivado `active`/`waiting for lock`/`idle` dicen lo que cada motor
  realmente quiere decir, y forzar uno sobre el otro sería solo inventar una
  correspondencia que ningún servidor tiene. La lectura de MongoDB es
  deliberadamente más estrecha que la de MySQL — `idleConnections`/
  `idleSessions` están las dos desactivadas, así que un pool de conexiones de
  cliente inactivas nunca aparece aquí, porque MongoDB no tiene un
  equivalente barato del estado "Sleep" de MySQL que merezca la pena mostrar,
  y mostrar cada sesión inactiva enterraría las operaciones que alguien vino
  a ver de verdad.

  Las sesiones de MySQL también llevan una cadena de bloqueo a mejor
  esfuerzo, leída de `performance_schema.data_lock_waits` cruzada con
  `performance_schema.threads` — el `Id` de una sesión propia, cuando se sabe
  que está esperando un bloqueo que otra sesión mantiene. Misma forma de
  degradar sin fallar que el resto de Pulse: un rol sin el privilegio, o
  `performance_schema` apagado, simplemente deja cada `blocked_by` vacío en
  vez de hacer fallar toda la lectura. MongoDB no identifica al bloqueador en
  este pase — `currentOp` no tiene un campo directo de "este opid espera a
  aquel opid", solo `waitingForLock` más el estado de bloqueo por operación,
  que necesitaría cruzar los recursos de bloqueo con los de cualquier otra
  operación en marcha para resolverse correctamente, y eso es trabajo real,
  sensible a la corrección, que se deja para más adelante en vez de
  adivinarlo. Una sesión de Mongo bloqueada se sigue viendo a través de su
  estado.

  Índices clasifica el uso desde el último reinicio de los contadores, de
  menos a más leído — el objetivo es señalar los índices que nadie toca.
  MySQL lee `sys.schema_index_statistics` (instalado en todo servidor desde
  la 5.7.7), que cubre cada tabla de la base de datos actual en un único
  viaje de ida y vuelta. MongoDB no tiene una forma de `$indexStats` a nivel
  de servidor como sí tiene `$collStats` para el almacenamiento, así que lee
  colección a colección — acotado a las veinte colecciones más grandes según
  el mismo ranking de tamaño que ya calcula `storage`, con el razonamiento de
  que un índice muerto en una colección diminuta desperdicia poco, mientras
  que las colecciones más grandes son donde uno cuesta más en disco y
  sobrecarga de escritura. El *tamaño* por índice se omite a propósito en los
  dos motores: MySQL lo guarda en `mysql.innodb_index_stats`, una tabla de
  sistema que las cuentas normales a menudo no pueden leer, y MongoDB
  necesitaría una segunda llamada a `$collStats` por colección junto a
  `$indexStats`, duplicando los viajes de ida y vuelta que el límite de
  veinte colecciones existe para evitar. Un índice realmente nunca leído
  (`Some(0)`) se muestra como "sin usar"; un servidor al que no se le pudo
  preguntar (`None`) se lee como un guion — son dos afirmaciones distintas, y
  confundirlas inventaría una cifra de uso o escondería un cero real.

  Nuevo: `pulse::{SessionRow, IndexUsage}`, `db::mysql::pulse::{sessions,
  index_usage, blocking_chain}`, `db::mongo::pulse::{sessions, index_usage}`,
  los comandos `pulse_sessions`/`pulse_index_usage`, y el hook compartido
  `useOnDemandRead` sobre el que se construyen las dos vistas nuevas del
  panel.

- **Pulse ya puede lanzar EXPLAIN sobre una sentencia, en los dos motores,
  directamente desde la tabla de digests.** Cada fila de la vista Consultas en
  la ventana ampliada tiene ahora una acción Plan; al pulsarla, envuelve el
  ejemplo capturado de esa fila en `EXPLAIN` y muestra el plan de solo lectura
  del servidor, sin llegar a ejecutar la sentencia de verdad. Hicieron falta
  dos piezas a la vez para que esto fuera seguro y no solo cómodo.

  Primero, un ejemplo ejecutable. `DIGEST_TEXT` está normalizado a
  marcadores `?` precisamente para que ejecuciones distintas se plieguen en
  una sola fila — lo cual también significa que no se le puede pasar a
  `EXPLAIN`. `QUERY_SAMPLE_TEXT` de MySQL (5.7.7+) es la sentencia literal
  detrás de una de esas ejecuciones, capturada junto al digest sin coste
  extra, y ahora viaja como `TopQuery.sample`. Una fila sin muestra (un
  servidor antiguo, o una forma de sentencia que `explain` no puede
  previsualizar) desactiva la acción en vez de mandar una petición condenada
  a fallar. **El fork de `performance_schema` de MariaDB nunca añadió
  `QUERY_SAMPLE_TEXT`**, así que la lectura del digest la intenta primero y
  reintenta una vez sin ella ante `ER_BAD_FIELD_ERROR` (1054) — sin esto, un
  servidor MariaDB con `performance_schema` realmente activado haría fallar
  toda la lectura de Consultas y se vería exactamente igual que uno con el
  profiler apagado, justo el fallo que el diseño de "degradar en vez de
  fallar" de esta vista existe para evitar.

  Segundo, que la vista Consultas exista siquiera en MongoDB: `system.profile`
  se lee ahora y se agrupa en la misma forma `TopQuery` que produce la tabla
  de digests de MySQL — por el `queryHash` propio del servidor cuando la
  entrada lo lleva, cayendo a espacio de nombres + comando en servidores más
  antiguos. El filtro de un `find` se convierte tanto en la etiqueta de la
  fila como en su `sample`, escrito con la misma sintaxis shell
  `db.coll.find({…})` que ya habla el editor de consultas — reutilizar ese
  único parser (en vez de inventar un segundo) es también lo que permite a
  `pulse_explain` reproducirlo: parsea la muestra de vuelta a un filtro, lo
  envuelve en el propio comando `explain` de MongoDB con verbosidad
  `"queryPlanner"` (nunca un nivel que ejecutaría la sentencia), y devuelve la
  respuesta tal cual. Las entradas de `update`/`delete`/`insert` se siguen
  agrupando y clasificando con normalidad — dicen a dónde fue el tiempo —
  simplemente no llevan `sample`, porque nada aquí reproduce una escritura.

  La comprobación que comparten los dos motores vive en un único sitio
  (`commands::pulse::validate_explain_target`), por delante de cualquier
  futura herramienta MCP que llegue al mismo `pulse_explain_inner`: solo
  lectura, rechaza una sentencia que sea ella misma `EXPLAIN`/`ANALYZE` (esto
  último *ejecuta* de verdad el objetivo, lo que anula el sentido de una
  previsualización), y rechaza un `;` suelto que podría colar una segunda
  sentencia más allá de la primera comprobación. Nuevo: `pulse::ExplainPlan`,
  `db::mysql::pulse::explain`, `db::mongo::pulse::{top_queries, explain}`, el
  comando `pulse_explain`.

- **Pulse también lee MongoDB.** `serverStatus` rellena las mismas cuatro
  tarjetas y las mismas reglas de aviso que MySQL, y `$collStats` rellena la
  clasificación de almacenamiento — la única llamada `$collStats` que ya hace
  el explorador de esquema, no un `collStats` por colección. El catálogo
  canónico de métricas es lo que convierte esto en una tabla de
  correspondencias en vez de un segundo panel: `connections.current` pasa a ser
  `connections_active`, la contabilidad de caché de WiredTiger pasa a ser el
  mismo par de aciertos, y las métricas para las que MongoDB simplemente no
  tiene equivalente (tablas temporales yendo a disco, el contador de consultas
  lentas) están **ausentes** en lugar de a cero, así que sus tarjetas muestran
  una raya en vez de un cero de aspecto saludable.

  Tres correspondencias que no son obvias y que se equivocan de forma invisible
  si se hacen deprisa. `queries` suma todas las entradas de `opcounters` en vez
  de leer una: `query` por sí solo se deja fuera los `getmore` de los que se
  compone casi entera una carga con muchos cursores. `connections_max` es
  `current + available`, porque MongoDB informa del margen y no del techo —
  informar de `available` mostraría un servidor al 43 % como casi ocioso. Y
  cada número se lee con la anchura BSON que el servidor haya elegido (el mismo
  contador es `Int32` en un servidor tranquilo, `Int64` cuando crece y `Double`
  dentro del bloque de WiredTiger), porque una lectura tipada perdería la
  métrica en silencio justo en los servidores que merece la pena medir.

  El almacenamiento encaja limpiamente: `storageSize`, `totalIndexSize` y
  `freeStorageSize` en el mismo reparto datos / índices / libre que ya
  significaba el `Data_free` de MySQL. Las estadísticas por sentencia son la
  única lectura que sigue faltando en MongoDB — su equivalente es el
  `system.profile` del profiler, con otra forma y su propia activación — y la
  sección dice ahora qué interruptor del servidor la rellenaría, en vez de
  enseñarle a un usuario de Mongo la redacción de MySQL.

- **Pulse se amplía a una ventana propia.** El botón ⤢ de la cabecera del
  panel abre una ventana del sistema que mide esa conexión — con anchura
  suficiente para la tabla completa de digests y la clasificación entera de
  almacenamiento, y libre para quedarse en un segundo monitor mientras el
  espacio de trabajo sigue donde estaba. Un rail a la izquierda lleva las
  vistas que hoy tienen una lectura detrás (Estado, Dónde va el tiempo,
  Almacenamiento); Sesiones, Índices y la retrospectiva del histórico se
  incorporarán cuando lleguen las suyas, porque una entrada del rail sin nada
  detrás es peor que una entrada ausente.

  **No** es un tab del espacio de trabajo ni tampoco una ventana de tab
  desacoplado. Pulse es contexto, no un documento: no tiene `TabKind`, no está
  en `useTabs` ni en el estado persistido de tabs, así que la ventana lleva un
  identificador de conexión y nada más (`open_pulse_window` /
  `take_pulse_window_intent`, siguiendo el patrón de intents que ya existía).
  El panel lateral sigue funcionando mientras está abierta y las dos
  **comparten un solo reloj**: la serie viva vive en un store y no en ninguno
  de los dos componentes, así que dos superficies sobre una conexión siguen
  siendo una sonda cada cinco segundos.

  Las tarjetas, la lista de avisos y la leyenda de almacenamiento son ahora
  componentes compartidos parametrizados por densidad en vez de estar escritos
  dos veces, y `usePulseView` deriva cada cifra en un único sitio. Dos
  superficies calculando «consultas por segundo» por separado es la forma en
  que acabarían discrepando sobre qué significa.

- **Pulse ocupa el panel: dónde va el tiempo y dónde ha ido el disco.** La
  primera entrega mostraba cuatro tarjetas y los avisos, y dejaba vacía la
  mayor parte de un panel alto. Ahora las siguen dos secciones: las sentencias
  en las que el servidor ha gastado más tiempo (la tabla de digests de
  `performance_schema` — texto normalizado, latencia media, ejecuciones, filas
  examinadas, y la cifra en rojo cuando la sentencia se resolvió sin usar
  ningún índice) y las relaciones más grandes (`SHOW TABLE STATUS`, repartido
  en datos / índices / espacio libre, con las barras escaladas contra la mayor
  para que la sección se lea como una clasificación). Tres filas cada una; las
  diecisiete restantes ya están descargadas, esperando a la ventana ampliada.

  Ninguna de las dos se sondea. Se leen cuando Pulse se hace visible y como
  mucho cada quince minutos, y una respuesta en caché más reciente que eso se
  reutiliza: alternar el panel derecho entre Guardadas y Pulse no puede
  reemitir la sentencia más cara que Pulse sabe mandar. Una actualización
  fallida deja en pantalla la última respuesta buena con el error anotado al
  lado, porque un servidor puede rechazar una de las dos lecturas y contestar
  perfectamente la otra, y vaciar una sección que hace un minuto estaba bien no
  ayuda a nadie.

  Dos apuntes sobre las cifras. La latencia es la **media**, no el p95: MySQL
  8.0 sí expone `QUANTILE_95` en la tabla de digests, pero 5.7 no tiene esa
  columna y una consulta que la nombre falla sin más — una cifra que funciona
  en todas partes vale más que dos caminos de código, y el percentil
  corresponde a la vista de Consultas ampliada, donde hay sitio para explicar
  de qué es percentil. Y `SHOW TABLE STATUS` en lugar de
  `information_schema.TABLES`, la misma llamada que ya hace el explorador de
  esquema: `information_schema` puede quedarse esperando indefinidamente por un
  metadata lock de InnoDB, que es justo el servidor sobre el que alguien tiene
  Pulse abierto.

- **HuginnDB Pulse: las constantes vitales del servidor en el panel derecho.**
  HuginnDB sabía decir qué hay *dentro* de una base de datos y nada sobre cómo
  está el servidor que la sostiene; responder «¿esto va bien?» obligaba a salir
  de la aplicación. Pulse es la primera parte de esa respuesta: un panel
  compacto en el panel derecho (se elige desde la barra de actividad, junto a
  Consultas guardadas) con cuatro tarjetas en vivo — consultas por segundo,
  presión de conexiones, hilos en ejecución y aciertos del buffer pool — cada
  una con su sparkline, más los avisos derivados de ellas. Solo MySQL en esta
  entrega; el resto de motores lo dicen explícitamente en lugar de pintar una
  columna de ceros.

  Lo que cuesta es la parte que se diseñó primero. El panel consulta cada cinco
  segundos y **solo mientras está en pantalla**: cambiar el panel derecho a
  Guardadas, plegarlo o minimizar la ventana detienen el reloj, y una conexión
  que nadie ha mirado no se muestrea nunca. Una sonda es un
  `SHOW GLOBAL STATUS`; si la anterior sigue en vuelo cuando toca la siguiente,
  se salta el tick, así que un servidor con problemas nunca acumula una cola de
  sondas de aquello que lo está midiendo. La serie viva vive en un store y no
  en el panel, de modo que la ventana ampliada (siguiente entrega) compartirá
  un único reloj con él en vez de duplicar la carga.

  Tres decisiones que conviene conocer. Los contadores cruzan el límite IPC
  **en crudo**, tal como los reporta el servidor, y las tasas se derivan de
  este lado, que es lo que permite detectar un reinicio del servidor (un
  contador que *baja*) en lugar de suavizarlo hasta convertirlo en un bache
  verosímil. Los nombres de métrica se normalizan a un catálogo independiente
  del motor (`pulse::METRICS`), así que `Threads_connected` de MySQL y
  `connections.current` de MongoDB son una sola tarjeta y un solo argumento MCP
  futuro; un motor sin equivalente para una métrica la omite, porque una
  lectura ausente y un cero son respuestas distintas. Y la cifra del buffer
  pool se calcula sobre el **último intervalo**, nunca sobre la vida del
  servidor: una máquina levantada seis semanas tiene un ratio histórico
  halagador por mal que esté rindiendo ahora mismo.

  Nuevos: `src-tauri/src/pulse/`, `src-tauri/src/db/mysql/pulse.rs`,
  `src-tauri/src/commands/pulse.rs`, `src/components/pulse/`,
  `src/lib/pulse/`, `src/stores/session/pulse.ts`. La tabla de correspondencias,
  la aritmética de tasas y los umbrales de los avisos son puros y están
  cubiertos por tests: una correspondencia de métrica equivocada no falla,
  simplemente dibuja el contador que no es.

- **El flujo de conexión de la CLI ahora sigue los entornos en vez de
  ignorarlos.** Es anterior a los entornos por completo, así que
  `--connect-profile[-id]` conectaba siempre en el entorno que estuviera
  activo en ese momento, aunque el perfil indicado perteneciera en realidad a
  otro — dejando la conexión, en silencio, en un sitio donde el usuario no
  estaba mirando. El nuevo helper `connectToProfile` de `useCliIntents`
  pregunta al backend qué entorno(s) referencian la conexión objetivo (un
  nuevo comando `find_environments_for_connection`, construido sobre el mismo
  `referenced_profile_ids` que ya usa el exportador de entornos) y cambia a
  ese entorno primero cuando el activo no está entre ellos. Por separado, un
  lanzamiento ad-hoc (`--host …` / `--uri …`) creaba siempre un perfil
  `ephemeral` nuevo, incluso cuando ya existía uno idéntico guardado — ahora
  reutiliza un perfil ya guardado y no efímero con el mismo
  driver/host/puerto/base de datos/usuario (o la misma cadena de conexión,
  para un lanzamiento `--uri`) a través de la misma vía de seguimiento de
  entorno, y solo recurre a crear un perfil desechable cuando no encuentra
  ninguna coincidencia.

### Añadido

- **Autocompletado al estilo Compass en el editor de agregación.** Escribir
  `$` en el cuerpo de un stage ahora ofrece los nombres de campo reales de la
  colección de origen junto a las sugerencias de operadores/constructores ya
  existentes, y un stage `$lookup` ofrece nombres de colección para `from`,
  los campos de la colección de origen para `localField` y los campos de la
  colección referenciada para `foreignField`. Construido enteramente sobre
  datos que ya están en memoria — la caché de colecciones/campos de
  `useSchema`, la misma que ya rellena el árbol de esquema — así que abrir el
  editor cuesta como mucho una consulta de muestreo de campos por colección
  realmente referenciada, nunca una por tecla. Ver el gotcha #57 en
  `CLAUDE.md` para el detalle de cómo se amplió el proveedor de
  autocompletado sin reintroducir el bug de "N proveedores duplicados" que
  ya cubre el gotcha #9.

### Cambiado

- **El panel derecho pasa a ser una selección, no un booleano — preparación
  para HuginnDB Pulse.** `useSessionPanelLayout` guardaba el panel lateral
  derecho como `savedOpen: boolean`, que era exactamente lo correcto
  mientras Consultas guardadas era su único ocupante. Pulse (un panel de
  rendimiento por conexión, que llega a continuación) se acopla en la misma
  ranura, y dos booleanos independientes no pueden representar una sola
  ranura: permiten que los dos estén «abiertos» a la vez sin que nada decida
  cuál ocupa realmente los 260 px de pantalla. El campo es ahora
  `rightPanel: "saved" | "pulse" | null`, y la barra de actividad derecha se
  comporta como un selector: pulsar la entrada activa cierra el panel,
  pulsar otra cambia a ella. Tres consecuencias que conviene conocer: cada
  ocupante conserva su **propio** ancho persistido (`savedWidth`,
  `pulseWidth`), porque el ancho cómodo para una lista de nombres de
  consulta no es el de una columna de tarjetas de métricas;
  `lastRightPanel` es lo que reabre el botón `PanelRight` de la cabecera,
  porque ese botón siempre ha alternado el *borde* y no un panel concreto,
  así que ahora se llama `panels.rightDock` en lugar de nombrar a uno de los
  paneles que podría traer de vuelta; y el layout persistido gana una
  migración real `version: 1 -> 2` que convierte `savedOpen: true` en
  `rightPanel: "saved"`, en vez del `return DEFAULTS` al que recurría el
  `migrate` anterior ante cualquier versión desconocida — perder el ancho
  del esquema y la altura de la consola de alguien por un renombrado no es
  un intercambio que merezca la pena. `src/stores/session/panelLayout.test.ts`
  es nuevo y cubre las dos mitades: los casos de caracterización (valores por
  defecto, recorte de tamaños, rehidratación) se escribieron contra el store
  antiguo antes de tocar nada, y los de migración comprueban que los campos
  arrastrados sobreviven.

- **Pasada de rendimiento de frontend.** Una regresión real reportada en
  máquinas modestas — una tabla de 10k registros en modo lista degradándose
  hasta ser inusable, y una imprecisión general del shell — que resultó no
  implicar al backend Rust en absoluto: cada entrada de abajo elimina un
  coste concreto, localizado por archivo y línea, en la capa React/DOM. Se
  entregó de forma incremental como una serie de commits propia, un punto
  por commit.

- **Los tokens de color se saltan la capa `color-mix()` por completo cuando no
  hay ningún `/modificador`.** `2ecaaf7` (la migración a `light-dark()` de
  1.19.0) movió cada token de color de Tailwind de `hsl(var(--x))` a
  `color-mix(in srgb, var(--x) calc(<alpha-value> * 100%), transparent)`,
  para que los modificadores de alpha al estilo `bg-brand/25` siguieran
  funcionando una vez que cada token pasó a ser un `light-dark(...)` completo
  (que `hsl()` no puede envolver). Eso se aplicó uniformemente, a propósito,
  incluso a colores que nadie usa nunca con modificador — pero significaba
  que cada color opaco pagaba un `color-mix()` + `calc()` en cada lectura, y
  `border-border` en particular sostiene `* { @apply border-border }` en
  `index.css`, es decir, el `border-color` de cada nodo del DOM en la app. El
  nuevo helper `colorToken()` de `tailwind.config.js` devuelve el `var(--x)`
  desnudo cuando Tailwind lo invoca sin modificador de alpha (o con un
  `/100` explícito) y la misma fórmula `color-mix()` en cualquier otro caso,
  y `corePlugins` desactiva ahora las utilidades legacy de opacidad
  (`bg-opacity-*`/`border-opacity-*`/`text-opacity-*`/`divide-opacity-*`/
  `ring-opacity-*`/`placeholder-opacity-*`, sin uso en `src/`), que es lo que
  encamina un `bg-card` sin clase de opacidad a través de la llamada sin
  modificador de Tailwind en vez de la indirección vía la custom property
  `--tw-bg-opacity` que esas utilidades exigen. Visualmente idéntico en
  ambos modos de color y en todos los temas integrados; verificado
  compilando clases de utilidad reales a través del motor `tailwindcss`
  instalado y comparando las declaraciones emitidas byte a byte contra la
  salida previa a `colorToken()` (`src/lib/tailwindColorTokens.test.ts`)
  para cada clase que sí usa un `/modificador`, más el stop de degradado
  `from-brand`, que ejercita `opacityValue: 0` — el único caso en el que un
  guard "falsy" (`!opacityValue` en vez de `opacityValue === undefined`)
  habría renderizado en silencio el stop "se desvanece a transparente" como
  totalmente opaco.

- **El modo lista ya no arrastra viva la maquinaria del virtualizador y de
  `useReactTable` del modo tabla.** `DataGrid` usa un único
  `<div ref={scrollRef}>` para ambos `viewMode`, y el pipeline
  `useVirtualizer`/`useReactTable`/`getCoreRowModel()` del modo tabla se
  ejecutaba de forma incondicional aunque `DocumentListView` fuera lo que de
  verdad se renderizaba dentro de ese contenedor de scroll. Con el tamaño
  virtual del propio virtualizador (número de filas × la altura de fila
  fija, un par de miles de px) totalmente desincronizado del contenido real
  de la lista, mucho más alto, su rango visible calculado cambiaba en casi
  cada evento de scroll — y cada cambio disparaba un re-render síncrono del
  grid completo (`flushSync`, vía el adaptador de `@tanstack/react-virtual`,
  que re-renderiza de forma incondicional sin la opción `directDomUpdates`
  que este grid no pasa). `useVirtualizer` recibe ahora
  `enabled: viewMode !== "list"` (limpia sus listeners internamente y se
  vuelve a suscribir por su cuenta al volver a modo tabla) y `useReactTable`
  recibe un array `data` vacío y estable en modo lista en vez de las filas
  reales, así que `getCoreRowModel()` deja de construir un árbol completo de
  `Row`/`Cell` para filas que nadie renderiza. Es la corrección directa de
  la degradación reportada ("página de 100 filas, modo lista, tabla de 10k
  filas") — las siguientes entradas de esta pasada abaratan la propia lista
  por fila.

- **El `memo()` por fila del modo lista ahora sí hace bailout, y un
  contenedor colegado deja de pagar por sus hijos ocultos.** Tres arreglos
  independientes en `DocumentListView`/`documentTree`:
  - `DocumentCard` ya estaba envuelta en `memo()`, pero nunca hacía bailout:
    `onFieldSave`/`onFieldDelete`/`onDeleteRow` llegan como declaraciones de
    función planas que `TableDataTab` recrea en cada render, y
    `onExpandField` como una arrow inline de `DataGrid` — una identidad
    nueva en cada render de algo varias capas por encima, siempre,
    independientemente de si los datos de esa fila concreta habían
    cambiado. Esos cuatro callbacks se reflejan ahora a través de una ref
    (`callbacksRef`, el mismo patrón que `interactiveRef`/`rowCallbacksRef`
    de `DataGrid` y el propio `callbacksRef` de `GridRow` ya usan) y se leen
    en el momento de la llamada en vez de pasarse como props;
    `DocumentCard` recibe solo booleanos (`hasFieldSave`, `documentMode`,
    …) para saber qué affordances están disponibles, que al ser primitivos
    se comparan barato y correctamente bajo `memo()`.
  - `FieldRow` recibe el mismo tratamiento un nivel más abajo: sus ~13
    callbacks inline por campo (recreados para cada campo de cada tarjeta,
    en cada render — decenas de miles de closures en una página ancha) se
    sustituyen por un único `actionsRef` estable, cuyos métodos reciben el
    campo sobre el que actúan como argumento, y la propia `FieldRow` queda
    envuelta en `memo()` por primera vez.
  - `flattenDocument` (`documentTree.ts`) materializaba una tupla `[clave,
    valor]` por cada hijo de un contenedor — incluido uno *colapsado* —
    solo para leer `.length` del resultado. Ahora lee el recuento
    directamente (`.length` / `Object.keys().length`) y solo recorre los
    hijos cuando el contenedor está de verdad expandido, así que un array
    colapsado de 10.000 elementos cuesta O(1) en vez de O(hijos) en cada
    render del memo de arriba.

  También eliminado: una suscripción `useTranslation()` por `DocumentCard`
  y por `FieldRow` (hasta ~4.000 combinadas en una página ancha — cada una
  una suscripción viva a i18next), sustituidas por una única suscripción en
  `DocumentListView` y un objeto `labels` de cadenas precalculadas
  (recalculado solo ante un cambio de idioma real); y un `columns.find()`
  por campo y por render para resolver el tipo de catálogo de una columna
  SQL (O(campos × columnas), ~160.000 comparaciones de string en 100 filas
  × 40 columnas), sustituido por un `Map` construido una vez por lista de
  columnas (`typeTextFor`, `documentTree.ts`).

  Verificado con un nuevo test de regresión
  (`src/components/grid/DocumentListView.test.tsx`) que habría detectado el
  bug original: vuelve a renderizar la lista con una identidad de
  `onExpandField` totalmente nueva (justo lo que hace `DataGrid` hoy) y
  afirma que el cuerpo de render de `DocumentCard` no se ejecuta una
  segunda vez.

- **Un arrastre del sash dejó de escribir en `localStorage` ~60 veces por
  segundo y dejó de re-renderizar el shell entero en cada frame.**
  `Sash.tsx` llamaba a `onResize(delta)` de forma síncrona en cada
  `pointermove` (~120 Hz observados), y cada uno de los cuatro call sites
  (los paneles Schema/Saved de `AppShell`, `ConsoleDock`, el split del
  editor de celda de `IslandShell`) lo conectaba directamente al middleware
  `persist` de `useSessionPanelLayout` — que hace `JSON.stringify` de todo
  el store y lo escribe a disco en cada `set()`. La mecánica del arrastre
  vive ahora en un nuevo hook `useSashDrag` que agrupa los `pointermove` en
  una sola llamada a `onResize` por frame de animación (sumando los deltas
  que caen entre medias, nunca descartándolos — descartarlos haría que el
  borde del panel se quedara rezagado respecto al cursor), y los cuatro
  call sites comparten ahora una nueva acción del store,
  `nudgePanel(key, delta)`, en vez de que cada uno calcule
  `actual + delta` en su propio scope de render (lo cual era además un bug
  latente: en el límite del clamp, el `actual` capturado por el callback
  podía ya estar desfasado respecto al store, dejando que el puntero se
  adelantara visiblemente al sash). El almacenamiento `persist` del store
  ahora tiene throttle de flanco final a 250 ms con un `flush()` explícito
  que los cuatro call sites invocan en `onDraggingChange(false)`, así que
  el valor en disco nunca queda más de un frame por detrás en el momento en
  que el usuario de verdad suelta.

  Además: `AppShell` ya no se suscribe directamente a
  `schemaWidth`/`savedWidth` — esa suscripción re-renderizaba todo su árbol
  de hijos (`IslandShell`, `ConsoleDock`, la barra de actividad derecha) en
  cada frame de arrastre. Los dos paneles laterales son ahora
  `SchemaSidePanel`/`SavedSidePanel`, cada uno con su propia suscripción al
  ancho, y cada uno renderiza el contenido de su panel
  (`SchemaPanel`/`SavedPanel`) como un elemento de React estable a nivel de
  módulo — la misma referencia de elemento en cada render — que es lo que
  permite a React hacer bailout de reconciliar ese subárbol entero aunque
  el propio wrapper se re-renderice por el ancho. El div interior de
  tamaño fijo de `CollapsiblePanel` recibe `contain: layout style` (seguro:
  tamaño fijo, el padre ya recorta con `overflow-hidden`), y el wrapper
  exterior recibe `will-change` solo mientras el arrastre está en curso, no
  de forma permanente.

- **Las `options`/`onChange` de Monaco son ahora referencias estables entre
  renders, en las siete superficies que montan uno.** El `<Editor>` de
  `@monaco-editor/react` ejecuta `editor.updateOptions(options)` en un
  efecto con deps `[options]`, y su cableado de cambio de contenido es un
  segundo efecto con deps `[isEditorReady, onChange]` que hace `dispose()`
  + `onDidChangeModelContent(...)` en cada cambio — pero cada uno de los
  siete call sites (el editor SQL, el panel de detalle de la Consola, el
  editor de celda, la previsualización de DDL, el editor de pipeline de
  agregación, el editor de vistas, el editor del cuerpo de JSON Schema)
  construía `options` como un objeto literal nuevo y `onChange` como una
  arrow inline nueva directamente en el JSX, así que Monaco se
  reconfiguraba a sí mismo — y tiraba y volvía a registrar su listener de
  contenido — en cada render del componente que lo rodea, sin importar si
  había cambiado alguna preferencia real. El nuevo
  `src/lib/monaco/useEditorOptions.ts` es un wrapper fino y con nombre
  sobre `useMemo` (el punto no es un mecanismo nuevo, es que el memo viva
  en un solo sitio que los demás call sites puedan copiar correctamente en
  vez de reescribirse a mano siete veces con siete ocasiones de equivocar
  el array de dependencias), emparejado con `useCallback` en cada
  `onChange`. Depende del objeto `EditorPrefs` completo tal como lo
  devuelve `usePreferences(selectEditorPrefs)`, referencialmente estable
  por el propio contrato de ese selector, más cualquier extra específico
  del call site como primitivo (nunca un objeto inline, que sería una
  referencia nueva en cada render y rompería el memo por la misma razón
  que el bug original). El componente `Editor` de `@monaco-editor/react`
  ya viene envuelto en `memo()` por el propio paquete, así que con ambas
  props estables ahora se salta el re-render por completo ante un render
  no relacionado del padre.

- **`content-visibility: auto` en el subárbol por conexión y en la lista de
  filas por sección del árbol de esquema.** Con el filtro del árbol activo
  puede haber miles de filas en los subárboles expandidos de cada conexión
  abierta, todo DOM real (el árbol no está virtualizado, ver la sección
  "Diferido" más abajo para el porqué de momento). `content-visibility:
  auto` se salta por completo el recálculo de estilos/layout/paint de lo
  que queda fuera del viewport de scroll del árbol, sin quitar nada del
  DOM — lo cual importa porque la navegación por teclado de `moveRowFocus`
  recorre `[data-tree-row]` vía `querySelectorAll` y dejaría de ver en
  silencio las filas fuera de pantalla si de verdad estuvieran
  virtualizadas. La lista de filas de `SchemaTableSection` recibe un
  `contain-intrinsic-size` exacto (`items.length * 24px` — las filas tienen
  una altura fija y conocida) en vez de una estimación; el wrapper del
  subárbol por conexión en `ConnectionsTree` recibe uno aproximado (`auto
  300px`, que se autocorrige en cuanto el navegador mide el subárbol real
  una vez). CSS puro, sin cambio de comportamiento — verificado a mano con
  el filtro activo, observando el panel Rendering de DevTools.

- **Teclear en el filtro del árbol de esquema ya no re-renderiza el árbol
  entero antes de que el debounce haya hecho nada.** `ConnectionsTree` se
  suscribía directamente al texto crudo de `useTreeSearch` (para pasarlo a
  `TreeFilterBox` como prop `value`) — el needle crudo cambia en cada
  tecla, y `ConnectionsTree` está por encima de cada fila de conexión y su
  subárbol expandido, así que cada tecla re-renderizaba todo eso, 180 ms
  antes de que el debounce (`TREE_SEARCH_DEBOUNCE_MS`) llegara siquiera a
  confirmar algo por lo que los subárboles pudieran filtrar de verdad.
  `TreeFilterBox` ahora lee y escribe el needle crudo, posee el efecto de
  debounce, y gestiona ella misma cada tecla que la caja lee (`Backspace`
  para pelar un nivel de scope, `Enter` para confirmar de inmediato) —
  `ConnectionsTree` conserva solo `needle`/`patterns`/`scope`, que cambian
  una vez por disparo del debounce, no una vez por tecla. `ArrowDown` es la
  única tecla que aún tiene que salir de la caja (mover el foco a la lista
  de filas necesita el propio DOM del árbol vía `moveRowFocus`), así que es
  lo único que sigue viajando por prop (`onArrowDown`). Preserva todos los
  invariantes documentados del camino de búsqueda: sigue habiendo
  exactamente un debounce; vaciar la caja sigue confirmando de inmediato;
  teclear sigue sin abrir ningún pool de conexión; una solicitud de foco
  sigue seleccionando el contenido de la caja; Backspace en una caja vacía
  sigue pelando un nivel de scope.

- **Una fila de conexión es ahora un componente real, y un arreglo real
  para un bug de remonte del header de grupo.** `renderConnection(p)` de
  `ConnectionsTree` era una función plana LLAMADA por fila (devolviendo
  JSX directamente), nunca renderizada como `<renderConnection />` — así
  que nunca fue una frontera de componente en absoluto, y el JSX de cada
  fila se reconciliaba como parte del propio paso de render de
  `ConnectionsTree`, sin nada de lo que React pudiera hacer bailout. Ahora
  es `ConnectionTreeRow`, envuelta en `memo()`, en su propio archivo. Sus
  cuatro callbacks (clic de fila, desconectar, reconectar, acotar el
  scope) se pasan a través de una ref en vez de como props planas o
  `useCallback`s — varios de ellos cierran sobre otros closures por
  render de `ConnectionsTree` (`filterFolds`, `setCollapsed`,
  `matchCounts`, …) que no están memoizados por sí mismos, así que un
  `useCallback` aquí quedaría obsoleto (un array de dependencias
  incompleto) o no ganaría ninguna estabilidad (uno exhaustivo, ya que la
  mayoría de esas dependencias cambian a menudo); una ref esquiva la
  pregunta de la misma forma que ya lo hacen el `rowCallbacksRef` de
  `DataGrid` y el propio arreglo de `DocumentListView` de esta pasada.

  Por separado, y este sí es un bug real y no una optimización perdida:
  `GroupHeader` (el header colapsable de una carpeta) era una `function
  GroupHeader(...)` DECLARADA DENTRO del propio cuerpo de render de
  `ConnectionsTree` y usada como JSX. Una función declarada dentro de un
  componente recibe una identidad nueva en cada render, y React lee un
  *tipo* de elemento cambiado como "esto es un componente distinto" — así
  que cada render de `ConnectionsTree` desmontaba y volvía a montar cada
  header de grupo. Movida a su propio archivo a nivel de módulo, envuelta
  en `memo()`, que es lo que hace que un componente sea seguro de
  memoizar en primer lugar (una identidad que no cambia es el
  prerrequisito que `memo()` necesita, no una optimización encima de él).

- **`memo()` en toda la familia de explorers del árbol de esquema, y —
  esta es la parte que realmente lo hizo útil— una prop que invalidaba
  cada fila de la página cada vez que cualquiera de ellas cambiaba.**
  `SchemaExplorer`, `SingleDbExplorer`, `MultiDbExplorer`, `TableSection`
  y `TableRow` están ahora todas envueltas en `memo()`, pero envolver solo
  `TableRow` no habría servido de nada: recibía como prop el slice de
  esquema COMPLETO por conexión (`cs`) y leía de él tres cosas (si su
  propio nodo estaba expandido, sus propias columnas, su propio error de
  carga de columnas) — y `TableDataTab.tsx` ya documenta que cargar las
  columnas de cualquier tabla escribe una referencia de mapa `columns`
  nueva para TODA la conexión. Así que expandir una fila de tabla
  invalidaba el memo de todas las DEMÁS filas de la misma página.
  `TableRow` recibe ahora esos tres valores como props propias
  (`expanded`/`columns`/`columnError`), calculadas una vez por fila por
  `TableSection` — que es lo que convierte "un toggle re-renderiza 500
  filas" en "un toggle re-renderiza 1".
  - El paquete `tableActions` de `SingleDbExplorer` (el objeto que
    `TableSection`/`TableRow` reciben para abrir/refrescar/renombrar/
    borrar/vaciar) se reconstruía como un objeto nuevo en cada render, lo
    cual por sí solo habría anulado ambos `memo()` de más abajo
    independientemente del arreglo de `cs` — envuelto en `useMemo`,
    colocado POR ENCIMA del `if (!cs)` de retorno anticipado por la misma
    razón de peso que ya obliga al `useMemo` existente de
    `bySchema`/`schemas` del archivo a estar ahí (un hook después de un
    retorno anticipado condicional es una violación de las Reglas de los
    Hooks en cuanto `cs` puede pasar a `undefined` entre renders, que es
    exactamente el escenario multi-DB de "varios explorers anidados se
    desmontan mientras `byConnection` se estabiliza" que el comentario de
    cabecera de este archivo ya advierte).
  - `ConnectionsTree` tenía su propia SEGUNDA suscripción ancha a
    `useSchema.byConnection` (`useTreeMatchCounts` ya tenía la primera),
    usada solo para el spinner de carga de la fila. El nuevo
    `useLoadingConnectionIds` (junto a `useTreeMatchCounts`, mismo
    archivo) la estrecha a un `Set<string>` de ids en carga —
    restaurando la afirmación del propio comentario de ese archivo de ser
    la única suscripción ancha de la app a ese mapa.

- **Una derivación sobre las tabs abiertas en vez de dos por fila del árbol
  de esquema.** `SchemaTableRow` ejecutaba ella misma
  `useTabs((s) => s.tabs.find(...))` y `useTabs((s) => s.tabs.some(...))`,
  cada una un escaneo O(tabs) — ambas devuelven primitivos, así que ninguna
  rompe la gotcha #1 ni re-renderiza una fila que no le afecta, pero
  ninguna evita *ejecutarse* tampoco. 500 filas × dos escaneos O(tabs) son
  1.000 iteraciones en cada escritura a `useTabs`, y teclear en el editor
  SQL es exactamente una escritura así, una por tecla (arreglado de raíz un
  commit más adelante, pero este escaneo era real de todas formas). El
  nuevo `useOpenTableKeys` (`src/lib/schema/useOpenTableKeys.ts`) calcula
  ambas respuestas — la clave de la tabla activa y el conjunto de claves de
  cada tabla abierta — en una sola pasada, llamado una vez por render del
  explorer en vez de una vez por fila, y entrega el resultado como dos
  props (`activeTableKey`, `openTableKeys: ReadonlySet<string>`)
  encadenadas a través de `TableSection`. La comprobación de pertenencia de
  cada fila (`openTableKeys.has(...)`) es lo que alimenta de verdad su
  estado `isOpen`/`isActive`, así que mientras esa pertenencia no cambie,
  sus props siguen siendo los mismos primitivos que eran — manteniendo
  intacto el bailout del memo de `TableRow` del commit anterior. El
  separador de clave `\0` se escribe como escape (`tableTabKey`), nunca
  como byte NUL literal — un byte NUL ya volvió el archivo entero binario
  para git una vez (sin diff, sin revisión, sin grep).

- **Una tecla en el editor SQL ya no se propaga al título de la ventana, a
  la maquinaria de la tira de tabs de dockview, a un re-render de la status
  bar por un comentario obsoleto, ni a N suscripciones de guardado en disco
  separadas.** `updateQuery` (`useTabs`) reemplaza todo el array `tabs` en
  cada tecla — correcto, ya que el texto de la query vive en el objeto tab
  — pero varios listeners no relacionados estaban indexados sobre `tabs`
  en sí en vez de sobre si algo que de verdad les importaba había
  cambiado:
  - `WindowTitleSync` recalculaba el título de la ventana del SO Y hacía
    la llamada IPC `setTitle` en un único efecto con deps `[tabs, activeId,
    profiles, selectedConnectionId, appName]`. El texto del título casi
    nunca cambia mientras se teclea (depende de qué conexión/tabla está
    activa, no del cuerpo SQL), así que el cálculo es ahora un `useMemo`
    separado y la llamada IPC depende de `[title]` — un string, así que
    solo se dispara cuando el título *renderizado* cambia de verdad.
  - El efecto de sincronización de paneles de `TabbedArea`
    (`syncTabPanels`) solo añade/quita paneles de dockview, así que solo
    necesita saber que la *identidad* de las tabs cambió, no que algún
    campo propio de una tab cambió — igual para el efecto de edge-fade
    justo debajo, que destruía y recreaba todo su `ResizeObserver` +
    listener de scroll en cada tecla. Ambos dependen ahora de una firma
    `tabs.map(t => t.id).join("\0")` en vez de `tabs` en sí, leyendo el
    array real vía `getState()` donde el diff de verdad necesita los datos
    completos de cada tab.
  - `StatusBar` seleccionaba `s.tabs.find((t) => t.id === s.activeId)`
    para su único uso — `activeTab.connectionId` — pero `.find()` devuelve
    una referencia de objeto *nueva* después de que `updateQuery`
    reemplace justo esa tab, anulando la optimización de selector de
    Zustand que el propio comentario de cabecera del archivo prometía.
    Estrechado para seleccionar `connectionId` directamente (un
    primitivo), y el comentario obsoleto de "`.find()` es estable" se
    corrige en el mismo cambio.
  - `persistedTabs.ts` registraba un `useTabs.subscribe(...)` POR CADA
    conexión rastreada, así que N conexiones vivas significaban N reinicios
    de temporizador de debounce por tecla en vez de uno. Consolidado en
    una única suscripción compartida que reparte a cada id del registro
    interno, registrada en la primera conexión y desmontada en cuanto el
    registro queda vacío — el ciclo de vida por conexión (`flushTabState`,
    `subscribedConnectionIds`, el guard `saveSuspended` del cambio de
    entorno) queda intacto por lo demás, ya que nada de eso dependía de
    *cómo* estaba cableada la suscripción, solo del propio registro.

  Diferido (necesitaría el visto bueno del usuario antes): sacar el propio
  borrador SQL de `useTabs` a su propio store. Ese es el arreglo de raíz —
  teclear no tocaría entonces nada de lo que observan el árbol, la status
  bar, el title sync o dockview — pero cambia la forma de la tab
  persistida y los caminos de hidratación/`replaceAll` de
  `persistedTabs.ts`, que tiene la forma de una migración de esquema y no
  de un arreglo del camino de render. Los cinco arreglos de arriba puede
  que ya basten por sí solos.

- **Un panel lateral/inferior colapsado ahora desmonta su contenido en vez de
  dejarlo corriendo indefinidamente detrás de un wrapper de ancho cero.**
  `CollapsiblePanel` (los slots de esquema/guardadas/consola/editor lateral
  del shell, desde el traslado fuera de dockview) solo animaba
  `width`/`height` entre 0 y el tamaño persistido — los hijos siempre
  estaban montados, colapsado o no, lo cual era invisible para un árbol o
  lista sencillos, pero no para `SideEditorPanel`: mantiene una instancia
  de Monaco viva y sus propios efectos corriendo toda la sesión aunque el
  panel nunca se haya abierto. Los hijos ahora se desmontan cuando termina
  la transición de *cierre* (`onTransitionEnd` en el propio wrapper,
  ignorando lo que burbujee desde dentro de `children`) — no en el instante
  en que `open` pasa a `false`, lo que haría que el contenido desapareciera
  de golpe con el wrapper todavía animando — y se remontan de inmediato al
  reabrir; la caja interior también recibe `content-visibility: hidden`
  mientras está colapsada, para lo que sea que se mantenga montado igual.
  Dos sitios de uso no pueden asumir el comportamiento por defecto:
  `SavedQueriesPanel` (un filtro de búsqueda sin guardar, un diálogo de
  renombrar abierto) y `SideEditorPanel` (una edición en curso, su línea
  base de detección de cambios, sesiones por-tab aparcadas) tienen ambos
  estado local de componente que un remonte descartaría en silencio, así
  que ambos pasan el nuevo escape `keepMounted` en vez de perderlo. El
  panel de esquema y la consola inferior usan el nuevo comportamiento por
  defecto — su estado ya vive en stores, no en el árbol de componentes.

- **`TableDataTab` reconstruía `onCellSave` — y con ello cada definición de
  columna de la rejilla — en cada uno de sus propios renders, remontando la
  `<tbody>` entera.** El propio comentario de cabecera de `useGridColumns`
  ya explica por qué es caro: `flexRender` de TanStack trata `columnDef.cell`
  como un TIPO de componente, así que un `columns` reconstruido es un tipo
  de elemento nuevo para cada celda, y React desmonta/remonta la `<tbody>`
  entera — el bug de "el cursor salta al final", a escala de toda la tabla.
  `onCellSave` es una dependencia declarada de ese memo, pero `TableDataTab`
  lo definía (junto con el `saveField` que envuelve) como una función
  declarada a secas, recreada en cada render — lo cual, dado con qué
  frecuencia cambia el propio estado de una tab de tabla (página, orden,
  búsqueda mientras se teclea), era a menudo. Ambos son ahora `useCallback`
  con una lista de dependencias exhaustiva, así que su identidad — y el
  `columns` de `useGridColumns` — solo cambia cuando algo que de verdad
  afecta a la consulta (columnas PK, tipos de catálogo, conexión/esquema/
  tabla, `fetchData`) cambia. `onNavigateFk` y el `onSelectionChange` en
  línea tenían el mismo tipo de bug un nivel más abajo: ambos son props
  directas (no por ref) del ya memoizado `GridRow`
  (`components/grid/GridRow.tsx`), así que una identidad inestable ahí
  anulaba ese memo en cada fila, en cada render, sin importar el arreglo de
  columnas de arriba. `pkColumnNames` (`pkColumns.map(...)`) y el respaldo de
  `searchHistory` (`filterHistory ?? []`) tenían el mismo problema, línea a
  línea — un array nuevo en cada render, el segundo solo cuando una conexión
  aún no tiene historial, la misma trampa que `NO_ROWS` (de este mismo
  archivo, del "commit 1") existe para evitar — ambos arreglados igual:
  `useMemo`/una constante de array vacío a nivel de módulo. Los cuatro
  bloques de contenido de toolbar/footer (`leadingToolbar`,
  `insertExtraContent`, `trailingToolbar`, `footerContent`) también están
  ahora memoizados, lo que requirió estabilizar los manejadores de
  exportar/importar que envuelven (`exportFull`, `exportFiltered`,
  `importCollectionJsonForTab`) de la misma forma — sin eso, envolver el JSX
  en `useMemo` mientras seguía capturando un closure nuevo en cada render
  habría sido un no-op. El comentario de cabecera de `GridRow`, que afirmaba
  que estos valores "se mantienen referencialmente estables" sin que eso
  fuera realmente cierto, se corrige para decir qué es lo que lo hace
  cierto y para advertir que el memo falla en abierto (en silencio, no
  ruidosamente) si un futuro punto de uso vuelve a romper el contrato. Se
  añade `useGridColumns.test.tsx`, un test de caracterización que fija el
  comportamiento real del array de dependencias: entrada estable → `columns`
  estable de salida, un cambio de identidad en `onCellSave`/`resultColumns`
  lo reconstruye, y mutar el CONTENIDO de `interactiveRef` (un simple clic)
  no lo hace.

- **El temporizador de ejecución del editor de consultas marcaba cada 50ms
  en el propio `QueryEditorTab`, re-renderizando la tab entera — Monaco
  incluido — veinte veces por segundo por cada consulta ejecutada.**
  `elapsedMs` existía solo para alimentar la pequeña insignia `QueryTimer`
  junto al botón de ejecutar, pero el `setInterval` que lo movía vivía en
  el padre como `useState` normal, así que cada tick era una actualización
  de estado en el mismo componente que aloja el editor SQL. Se extrae
  `useElapsed` (`src/lib/useElapsed.ts`): un hook pequeño que posee el
  estado de `elapsedMs` (marcando) y el resultado congelado, más un par
  `start`/`stop` estable. `QueryTimer` ahora lo llama él mismo y expone
  `start`/`stop` vía `useImperativeHandle`, así que `QueryEditorTab` mueve
  el temporizador a través de un `queryTimerRef` —
  `queryTimerRef.current?.start()` / `.stop(ok)` — sin suscribirse nunca al
  valor que cambia en cada tick. `runQuery`/`runBatch` perdieron
  `startTimer`/`stopTimer` de sus propios arrays de dependencias como
  consecuencia: leer un ref no necesita entrada. Se añade
  `useElapsed.test.ts` con `vi.useFakeTimers()`, cubriendo la cadencia de
  los ticks, la congelación en `stop()`, que un segundo `start()` reinicia
  sin duplicar ticks, y que el intervalo realmente se limpia al desmontar.

- **Investigado, y sentada la base para, limitar el trabajo por-tab mientras
  una tab está en segundo plano.** El propio comentario de cabecera de
  `TabbedArea` explica el diseño a propósito: cada tab abierta mantiene su
  propio árbol de React montado durante toda su vida, específicamente para
  que cambiar de tab no reinicie el borrador de filtro de una tabla ni la
  posición de scroll de un editor de consultas (gotcha #10 de `CLAUDE.md`).
  Eso significa que el temporizador de ejecución de una consulta, el
  virtualizador de una rejilla, o cualquier otro trabajo recurrente por-tab
  sigue corriendo para tabs que nadie está mirando ahora mismo — no por un
  bug, sino por el mismo diseño que hace que cambiar de tab se sienta
  instantáneo. Desmontar las tabs en segundo plano para detener ese trabajo
  se consideró y se descartó: reintroduciría exactamente la pérdida de
  estado que `TabbedArea` existe para evitar, a cambio de un coste que (tras
  el arreglo de aislar el tick, dos entradas más arriba) ya está confinado
  sobre todo al pequeño componente que de verdad hace el tick, no a la tab
  entera. Lo que se añade en su lugar es `useIsPanelVisible`
  (`src/lib/tabs/useIsPanelVisible.ts`): un hook pequeño que lee
  `DockviewPanelApi.isActive`/`isVisible` — ambos ya entregados a cada
  componente de panel como `props.api`, sin necesitar contabilidad a nivel
  de grupo — para que un futuro consumidor pueda preguntar "¿alguien está
  viendo esto siquiera?" sin desmontar nada. No se conecta a `QueryTimer` ni
  al virtualizador de la rejilla en esta pasada: hacerlo con seguridad
  requiere auditar cada consumidor sobre qué debería significar realmente
  "en pausa mientras está en segundo plano" (¿el temporizador de una
  consulta en segundo plano se congela o sigue contando para cuando el
  usuario vuelva?), lo cual pide su propio cambio acotado y sus propias
  pruebas en vez de venir de paso aquí. Cubierto por
  `useIsPanelVisible.test.ts` contra una réplica mínima de los dos eventos
  que lee.

## [1.19.0] — 2026-08-27

### Añadido

- **Las familias de tema se declaran una sola vez, con sus dos variantes
  (clara y oscura) juntas, y la app las pinta ahora con la función CSS nativa
  `light-dark()`.** Cada tema integrado eran antes dos registros `Theme`
  independientes en `BUILT_IN_THEMES` (`claude-light`/`claude-dark`, …)
  enlazados solo por un campo `pairId` cruzado, y el toggle claro/oscuro
  (`setActiveMode`) reaplicaba las ~28 variables CSS en cada pulsación porque
  conceptualmente cambiaba de un objeto `Theme` a otro. Las cinco familias
  integradas (HuginnDB, Claude, Neon, Summer, High Contrast) declaran ahora
  `{ light: ThemeColors, dark: ThemeColors }` una sola vez — `pairId`
  desaparece — y `applyTheme` escribe `--x: light-dark(hsl(…), hsl(…))` por
  variable en vez de un único valor resuelto. El toggle de modo
  (`applyColorScheme`) ya no toca ninguna variable de color: solo cambia
  `color-scheme` (más la clase `.dark` de Tailwind, que sigue haciendo falta
  para la variante `dark:` que usan algunos componentes) y deja que el
  navegador elija la mitad correcta de cada `light-dark()` — un toggle O(1)
  en vez de reaplicar toda la paleta. `color-scheme` se fija siempre a un
  único valor (`light` u `dark`), nunca `"light dark"`, para que resuelva
  según la elección manual del usuario y no según `prefers-color-scheme`.

  Los temas personalizados del usuario también declaran ahora ambas
  variantes, en vez de ser una excepción de un solo modo — el editor de
  Apariencia ganó un selector "editando: claro | oscuro" (independiente del
  toggle global de modo) para editar cada variante de un tema personalizado
  por separado, y duplicar/bifurcar un tema integrado clona ambas variantes
  a la vez. El formato de exportación de `themeTransfer.ts` pasó a v2
  (`{ name, light, dark }`); importar un archivo v1 anterior a este cambio
  (`{ name, mode, colors }`) sigue funcionando — su única paleta se duplica
  en ambas variantes como punto de partida. El estado ya persistido en
  `localStorage` y el `theme_id` guardado/importado de un `Environment` (una
  simple cadena opaca para el backend — Rust nunca la interpreta) migran de
  forma transparente mediante una pequeña tabla de ids antiguos que mapea los
  diez ids previos a las cinco familias nuevas.

  Como `--x` pasó de ser un triple crudo `"H S% L%"` a un color completo
  `light-dark()`, se revisó cada uso de `hsl(var(--x))`/`hsl(var(--x) / N)`
  en el código (`tailwind.config.js`, `index.css` y una veintena de
  componentes) hacia `var(--x)`/`color-mix(in srgb, var(--x) N%,
  transparent)`. Los tokens de color de `tailwind.config.js` usan
  específicamente el marcador `<alpha-value>` de Tailwind en vez de envolver
  el modificador en un `color-mix()` literal — el propio parseo de
  modificadores de opacidad de Tailwind (`bg-brand/25`) hace coincidencia de
  texto sobre `hsl(var(--x))` y no reconoce `var(--x)` ni `light-dark(...)`,
  así que todos los tokens de color necesitaban ese marcador de forma
  uniforme para que los modificadores `/NN` siguieran funcionando (una
  omisión ahí falla en silencio — el modificador simplemente se descarta, no
  hay error — en vez de avisar).

- **Un editor para el documento que publica un origen compartido.** Un origen
  compartido (#108) era estrictamente de solo lectura: `sync_origin` leía el
  fichero y nunca lo escribía, así que publicar significaba ejecutar «Exportar
  entornos…», elegir un destino en el diálogo nativo y soltar el JSON en el
  recurso compartido. Actualizarlo significaba repetir esa exportación desde lo
  que el publicador tuviera montado en ese momento — o editar el JSON a mano.

  Eso costaba tres cosas en la práctica. El publicador solo podía publicar lo
  que estuviera configurado en su propia máquina en ese instante. Cualquier
  cambio pequeño — renombrar un entorno, quitar una conexión — exigía una
  reexportación completa, que **vuelve a cifrar cada secreto del fichero**
  (`encrypt_secret` genera una sal y un nonce nuevos en cada llamada), lo que
  invalida la caché `landed_secrets` de cada consumidor y le impone decenas de
  millones de rondas de PBKDF2 en su siguiente sincronización. Y no había forma
  de ver qué le haría un publish al equipo antes de hacerlo — incluido el caso
  que más importa, más abajo.

  Ajustes → Orígenes compartidos → «Editar el documento…» abre ahora un editor
  a pantalla completa para el fichero: qué conexiones publica y cómo viaja la
  contraseña de cada una, los entornos y su composición, el subconjunto de JSON
  Schemas y sus vínculos, y los metadatos de publicación. Cada panel ofrece
  como lado izquierdo lo que esta máquina ya tiene — la lista de conexiones, la
  biblioteca de esquemas y (vía `list_publishable_environments`) los propios
  entornos de esta máquina, resueltos con el mismo `referenced_profile_ids` que
  usa la exportación —, así que construir un fichero desde cero es copiar en
  vez de volver a teclear. Importar un entorno trae consigo las conexiones que
  referencia, ya que un entorno cuya composición nombra ids que el documento no
  lleva es un filtro sobre nada. Un entorno *espejo* queda excluido a
  propósito: su identidad para un consumidor es el `origin_source_id` del
  publicador, no el `Environment::id` local bajo el que tendría que publicarse,
  así que copiar uno crearía un segundo paquete para un entorno que el
  documento puede ya llevar. Es un editor del **documento**, no una vista de
  esta máquina: nada en él lee de `profiles.json`, `tab_state.json` o
  `json_schemas.json` ni escribe en ellos, y guardar no cambia nada en local.
  El fichero que construye es el mismo `transfer::EnvironmentExportFile` que ya
  escribe el comando de exportación — un formato, un constructor
  (`origin_doc::build_origin_file`), así que los dos nunca pueden divergir.

  **Una contraseña que no ha cambiado viaja tal cual.** Todo secreto cargado
  desde el fichero arranca como una ranura «mantener» y se copia byte a byte,
  que es lo que hace que renombrar un entorno le cueste al equipo exactamente
  cero derivaciones de clave en vez de 600 000 por ranura y conexión. Rotar la
  frase de contraseña es la única operación que vuelve a cifrar todo, y es un
  interruptor explícito con el coste anunciado justo al lado.

  **La vista previa de publicación dice lo que nadie más puede.** Simula la
  siguiente sincronización de un consumidor ejecutando el `merge_into` real
  contra el fichero que está a punto de sustituir — añadidos, cambios
  genuinos, desapariciones, más la factura de recifrado y lo que recibe una
  máquina nueva. La fila que justifica toda la función es la silenciosa:
  superado el umbral de sospecha de `commands::origins`, la sincronización de
  un consumidor decide que la lectura está rota y vacía su propia lista
  `vanished`, así que publicar un fichero al que le falta media plantilla
  dejaba a cada consumidor con conexiones fantasma y **sin aviso alguno**. No
  había superficie en el producto donde eso fuera detectable; ahora el diálogo
  de confirmación lo dice y sugiere partir el cambio en dos.

- **Los orígenes tienen un rol, y es una de tres capas.** `Origin.role`
  (`consumer` por defecto, `#[serde(default)]`) registra la *intención* — todo
  origen registrado antes de esto, y cualquiera nuevo, es un consumidor, así
  que nadie gana acceso de escritura a un fichero compartido instalando una
  actualización. Cambiarlo es explícito, se confirma y es reversible. La
  *autoridad* es el sistema operativo: `probe_origin_writable` crea y borra un
  fichero real junto al documento antes de que el editor ofrezca guardar,
  porque los permisos de un recurso compartido de Windows describen el montaje
  local y no lo que aceptará el servidor — un recurso de solo lectura abre el
  editor en modo lectura en vez de fallar en el último paso. `meta.maintainer`
  / `meta.revision`, dentro del fichero, son la tercera capa y son *solo
  coordinación*: lo que de verdad impide que dos publicadores se pisen es el
  hash del contenido que compara el guardado.

- **El registro en sí ya se puede editar.** `update_origin` llegó en la 1.18
  sin ningún punto de uso: un origen se podía registrar y eliminar, pero nunca
  renombrar ni repuntar, así que un recurso compartido que cambiaba de sitio
  significaba borrar el registro y volver a adoptar cada conexión que había
  publicado. Ajustes → Orígenes compartidos tiene ahora ese formulario, con un
  selector de fichero en vez de un simple campo de texto para la ruta, y una
  acción «Nuevo documento…» que crea un fichero vacío en el recurso compartido
  y lo registra como uno que esta máquina publica.

- **Un origen compartido ya sincroniza los JSON Schemas que lleva su
  fichero.** `docs/JSON_SCHEMAS.md` decía que esto no estaba conectado, y no lo
  estaba — el cableado (`origin_id` en los dos tipos, el paquete dentro de
  `EnvironmentExportFile`) existía, pero nada lo leía al sincronizar. Ahora sí,
  con las mismas reglas que ya siguen las conexiones y no las del importador
  puntual: las entradas se emparejan por **id**, no por nombre, así que un
  sondeo cada cuatro horas refresca en el sitio en vez de acumular `cfg (2)`,
  `cfg (3)`, …; solo se sobrescriben las entradas que el origen ya posee, así
  que un esquema que has escrito tú nunca se toca y un nombre publicado que
  coincide con el tuyo se aparta; un vínculo que nombra una conexión que esta
  máquina no tiene llega **deshabilitado**, conservando su fijación; y nada se
  borra — una desaparición se informa, igual que la de una conexión.

- **DDL de índices y colecciones de MongoDB, alcanzable desde el editor de
  consultas y por MCP.** El aviso que originó esto venía del cliente de IA de
  un compañero, y era correcto: el conector no tenía forma de crear un índice,
  eliminarlo, eliminar una colección ni renombrarla — «ni por `run_query` ni
  como herramienta aparte». `drop_view` rechaza una colección a propósito (en
  MongoDB una vista y una colección comparten un mismo *namespace*, y un nombre
  mal escrito no debe borrar documentos), así que tampoco había vía indirecta.

  **El hueco estaba en la gramática, no en el conector.** La lista de
  operaciones aceptadas es `build_op` en `db/mongo/shell.rs` — el parser que usa
  el *editor de consultas de escritorio* — así que el editor tampoco podía crear
  un índice. Ampliarla arregló las dos superficies de una vez:
  `db.coll.createIndex({createdAt: -1})`, `dropIndex("nombre")`,
  `hideIndex`/`unhideIndex`, `drop()` y `renameCollection("clientes")` ya se
  parsean y ejecutan. Cada operación delega en el código que ya tenía sus
  guardas en lugar de emitir su propio run-command, así que el rechazo de
  `_id_`, el nombre por defecto de `createIndexes` y el `dropTarget: false`
  siguen aplicando — y `dropTarget: true` lo rechaza el parser, porque de otro
  modo la gramática sería la única vía para que un renombrado borrara en
  silencio lo que ocupara el nombre destino.

  `renameCollection` es solo dentro de la misma base de datos, igual que lo que
  acepta `mongosh`. El movimiento entre bases se queda en el diálogo Renombrar
  del explorador: un `"otraBd.coll"` cualificado parece la forma obvia, pero un
  nombre de colección puede contener puntos legítimamente (`system.views`,
  `logs.2024`), así que esa lectura convertiría un renombrado válido en un
  movimiento silencioso.

  **Dos herramientas MCP, solo para MongoDB: `create_index` y `drop_index`.**
  Ambas en el nivel `full`, y eso fue forzado más que elegido — `createIndex`
  por `run_query` se clasifica como DDL, así que una herramienta en `data`
  habría devuelto justo lo que la vía de sentencias niega. No hay nada para los
  drivers SQL a propósito: allí un índice se crea con `CREATE INDEX`, que
  `run_query` ya alcanza en `full` y que es estrictamente más expresivo que
  cualquier conjunto fijo de campos (`USING gin`, `INCLUDE`, un predicado
  parcial). Y nada para reemplazar un índice, porque MongoDB no puede alterarlo
  en sitio: es un borrado más una creación, y dos llamadas mantienen visible la
  ventana en la que el índice no existe.

  **`list_indexes` tuvo que crecer con ellas.** Por MCP devolvía la forma SQL
  `{name, columns, unique}`, así que un modelo que leyera `["createdAt"]` y lo
  reescribiera recrearía el índice *ascendente* — invisible en pruebas,
  permanente en los datos. Su rama del bridge ahora responde desde el lector
  rico en MongoDB y cada entrada lleva un objeto `mongo` con la definición real:
  dirección y tipo de cada clave, `sparse`, TTL, filtro parcial, colación,
  pesos, tamaño y uso. El explorador sigue usando el lector con pérdida, así que
  las llamadas extra a `$collStats`/`$indexStats` solo se pagan en la vía MCP.

  Las escrituras de índices ahora emiten entrada en la Consola, algo que nunca
  hicieron — el mismo *seam* de `LogSink` que las lleva a `mcp-audit.log`.

- **El sistema de atajos de teclado, reconstruido.** Salió en la 1.10.0 como lo
  más pequeño que podía funcionar — ocho acciones reasignables, una
  combinación cada una, y 127 líneas sosteniendo juntos el catálogo, el léxico
  de teclas y el comparador. Lo que no podía expresar se había ido
  acumulando: sin teclas secundarias, sin secuencias de combinaciones, sin
  noción de *dónde* se aplica un atajo, sin forma de desasignar nada, y sin
  ningún test.

  **Una asignación es ahora una lista.** `prefs.json` guarda
  `["Mod+Enter", "F9"]` en vez de una sola cadena: la primera entrada es la
  principal (lo que muestran los menús, la paleta y los tooltips), el resto
  son alias que disparan la acción igual de bien. Tres estados se mantienen
  distintos y los tres significan algo — una clave ausente es «usa el valor
  por defecto», `[]` es «lo he desasignado a propósito», y una lista no vacía
  es la principal más los alias. `Preferences.keybindings` pasó a ser
  `HashMap<String, Vec<String>>` detrás de un deserializador que también
  acepta la cadena suelta antigua, así que un `prefs.json` existente no
  necesita migración ni subir de versión. (Un downgrade a una build anterior a
  esto no puede parsear la forma en lista, y como un `prefs.json` inválido cae
  a los valores por defecto, ese downgrade pierde todas las preferencias, no
  solo los atajos. Documentado junto al deserializador.)

  **Las secuencias de combinaciones funcionan**, al estilo VS Code: `Mod+K` y
  luego `Mod+S`. Nada sale de fábrica como secuencia — existen para tener
  dónde poner los comandos que ya no caben en una sola combinación. Un prefijo
  a medio teclear espera dos segundos y se muestra en la barra de estado,
  porque un atajo que se traga en silencio la siguiente pulsación se percibe
  como un teclado roto.

  **Las acciones tienen ahora un ámbito**, y se resuelve desde el DOM: una
  superficie declara `data-kb-scope` y el más cercano al elemento con foco
  decide qué se escucha, junto con `global`. Esto es lo que permite que
  `grid` y `editor` compartan la misma tecla sin ambigüedad, y sustituye los
  arreglos improvisados que habían acumulado los cuatro listeners anteriores —
  `DataGrid` filtrando a mano las combinaciones con modificador,
  `SideEditorPanel` llamando a `stopImmediatePropagation` para ganar una
  carrera por `Mod+S`. Un único `createKeyDispatcher` sirve ahora tanto al
  listener de la ventana como al `onKeyDown` de Monaco (el editor sigue
  necesitando su propio reenvío — `addCommand` congela una máscara de bits de
  la asignación al registrarse y no puede volver a comprobar una en vivo).

  **El catálogo creció de 8 acciones a 25, fusionado con el de la paleta de
  comandos.** La paleta ya sabía ejecutar dieciséis comandos y los menús unos
  cuantos más; a ninguno se le podía dar una tecla, porque la tabla de atajos
  era una lista aparte que describía por casualidad algunas de las mismas
  acciones. Cada acción nueva reutiliza la etiqueta que ya tenía la paleta o
  el menú, así que hay un nombre por comando en vez de una segunda redacción
  para la lista de atajos. La mayoría sale a propósito **sin asignar**: estar
  en el catálogo es lo que hace que una acción sea buscable, asignable y se
  compruebe por conflictos, y gastar una tecla por defecto en ella le quitaría
  esa tecla a lo que el usuario de verdad quiere usar. Cuatro sí la tienen:
  `Mod+T` (consulta nueva), `Mod+W` (cerrar pestaña), `Mod+B` (panel de
  esquema) y `` Mod+` `` (consola), más `Mod+Shift+N` para una ventana nueva.
  La paleta y los menús leen ahora la asignación en vivo en vez de repetirla,
  así que una reasignación aparece en los dos sin recargar.

  **Ajustes → Atajos se reconstruyó** alrededor de las tres preguntas que en
  realidad se le hacen a una lista de veinticinco. *Qué dispara esta acción* —
  cada asignación es su propio chip, clic para volver a grabar, `×` para
  quitarla, `+` para añadir; las teclas reservadas quedan al lado, atenuadas.
  *Qué hace esta tecla* — un chip «Por tecla» convierte la caja de búsqueda en
  un campo de captura y filtra a quien use la combinación que pulses. *Qué he
  cambiado* — un filtro «Modificado» y un contador, que es por lo que
  «Restablecer todo» ahora **vacía** el mapa de anulaciones en vez de escribir
  en él cada valor por defecto: una anulación igual a su valor por defecto no
  es una anulación, y ese filtro estaría mintiendo. La grabación se trasladó a
  un diálogo, donde la captura está *armada, no permanente* — mientras está
  armada se come cualquier tecla, así que `Escape` y `Enter` son asignables;
  en cuanto aterriza una combinación se desarma y esas dos vuelven a
  significar Cancelar y Guardar.

  **Los conflictos dejaron de ser un muro.** Un choque solo se informa cuando
  los dos ámbitos pueden de verdad escucharse a la vez, así que todo lo que se
  informa es una ambigüedad real — y el diálogo ofrece quitarle la tecla a la
  otra acción, en la misma operación, en vez de limitarse a rechazar. Ahora
  también ve las asignaciones reservadas y la grafía normalizada, dos cosas
  para las que la comprobación antigua era ciega: reasignar algo a `Mod+R`
  se aceptaba antes en silencio y luego nunca disparaba.

  **Los atajos se exportan e importan** como JSON, siguiendo
  `themeTransfer.ts`. Solo viajan tus anulaciones, nunca las asignaciones ya
  resueltas — exportar lo que hace cada acción ahora mismo grabaría a fuego
  los valores por defecto de esta versión en el fichero e impediría a la
  máquina que importa recibir cualquier valor por defecto añadido después. Una
  acción que la build que importa no reconoce se nombra en vez de descartarse
  en silencio.

  Dos defectos de toda la vida se fueron con la reescritura. **Nada
  comprobaba dónde estaba el foco:** la única guarda del listener antiguo era
  `e.isComposing`, así que asignar una acción a una letra suelta volvía esa
  letra intecleable en toda la app — ahora una combinación indistinguible de
  escribir se suprime dentro de un campo de texto, mientras que `F5`,
  `Escape` y las flechas siguen funcionando ahí. Y **`Ctrl+Enter` solo era
  reasignable en uno de los tres editores Monaco**; los editores de vista y de
  pipeline usaban un `addCommand` fijo. Los dos pasan ahora por el reenvío.

  Además: `Ctrl` en una combinación guardada pasa a llamarse `Mod`, que es lo
  que siempre significó (`ctrlKey || metaKey`) — el nombre antiguo era una
  mentira en macOS y no dejaba forma de asignar la tecla Control real, que
  `Ctrl` y `Meta` cubren ahora como tokens exactos. Las combinaciones
  guardadas migran al leerlas, así que no se reescribe nada en disco.
  Documentado en `docs/SHORTCUTS.md` (inglés y español), y cubierto por 96
  tests de frontend más dos tests de contrato en Rust donde antes no había
  ninguno.

- **Ajustes → MCP es ahora un árbol, con botones de política en lote.** Recibe el
  mismo filtro Todas / Locales / Compartidas y las mismas secciones plegables por
  origen que el gestor de conexiones, más las carpetas de grupo, así que un
  servidor está en el mismo sitio en las dos superficies — con menos información
  por fila, porque un snippet se construye con ids, no con endpoints. Debajo de la
  lista, un botón por política pone **todas las conexiones listadas** a la vez (el
  filtro de procedencia y la búsqueda deciden qué es «listadas», y el contador
  está en el propio botón). «Completo» pregunta antes: es el nivel que permite a
  un cliente de IA cambiar el esquema.

  Los botones actúan sobre lo listado y no sobre lo marcado, porque las casillas
  ya responden a otra pregunta —qué conexiones exponer— y un mismo control no
  puede significar dos cosas.

- **El gestor de conexiones ya distingue las conexiones locales de las que
  publica un origen compartido.** Un origen registrado (#108) importa sus
  conexiones junto a las tuyas y, hasta ahora, nada en el gestor decía cuál era
  cuál. Peor aún: las carpetas de grupo se fundían a través de esa frontera, así
  que una carpeta "Producción" tuya y una "Producción" que publica IT aparecían
  bajo la misma cabecera. La lista arranca ahora con un filtro **Todas /
  Locales / Compartidas** (con contadores) que desaparece por completo si no
  tienes ningún origen registrado. La vista Compartidas se divide en una sección
  plegable por origen, con su nombre y marcada como de solo lectura, más una
  sección final para las conexiones cuyo origen ya no está registrado. En las
  otras dos vistas, una conexión compartida lleva un distintivo cuyo tooltip
  nombra el origen que la publica.

  Ajustes → MCP recibe las mismas secciones, y ahí está el motivo de todo el
  cambio: una conexión publicada por un origen conserva **el mismo id en todas
  las máquinas**, así que un snippet del conector hecho con conexiones
  compartidas sirve tal cual para todo el equipo, mientras que uno hecho con una
  copia local antigua solo funciona en tu portátil — y eligiendo ids de una lista
  plana no había forma de distinguirlas.

- **«Eliminar todas las locales»**, en el menú de la lista de conexiones. La
  forma prevista de pasar un equipo a un origen compartido es borrar las copias
  locales y quedarse solo con lo que publica el origen; antes eso había que
  hacerlo conexión a conexión. Está deshabilitada mientras haya una búsqueda
  activa: con un filtro puesto, «todas» es ambiguo, y equivocarse borra
  conexiones que no has visto. Para ese caso están las casillas, donde lo que va
  a caer está en pantalla.

- **Columnas fijadas ("congeladas") en la cuadrícula de datos, al estilo
  Excel.** Un pequeño icono de pin en la cabecera de cada columna — visible al
  pasar el ratón, siempre mostrado una vez fijada — alterna una columna entre
  desplazarse con normalidad y quedarse fija en el borde izquierdo. Se puede
  fijar cualquier número de columnas a la vez; se apilan en el orden natural de
  la tabla (izquierda a derecha), no en el orden en que se fijaron, y la
  columna de selección/número de fila siempre queda fijada primero, como el
  ancla sobre la que las demás calculan su desplazamiento. Se persiste por
  tabla (igual que los anchos de columna), con la misma clave, y se salta en
  resultados de consultas ad-hoc, que fijan solo durante la sesión.

  El lado de la cabecera fue sencillo — cada `<th>` ya pinta su propio fondo
  opaco, así que solo hacía falta `position: sticky` y el desplazamiento
  `left` correcto. El lado del cuerpo necesitó una solución real, no el mismo
  tratamiento: el fondo de una fila vive en su `<tr>`, y los tintes
  translúcidos usados para selección/multiselección/rayado cebra
  (`bg-brand/30`, `bg-brand/10`, `bg-muted/30`) son translúcidos *a
  propósito* — un lavado sutil sobre el fondo de la página es el aspecto
  buscado para una fila normal. Una celda `position: sticky` no puede usar
  eso: en cuanto el navegador la promociona a su propia capa de composición,
  un fondo translúcido deja pasar lo que se desplaza por debajo, así que una
  celda fijada en una fila seleccionada o con rayado cebra mostraba su propio
  texto superpuesto al de la siguiente columna. Las celdas fijadas/gutter
  ahora reciben un equivalente *sólido* del mismo tinte, calculado con
  `color-mix()` vía estilo en línea, de modo que se ven idénticas a sus
  vecinas no fijadas mientras ocultan de verdad lo que se desplaza detrás. La
  única concesión aceptada: una celda fijada no recibe el tinte de hover de
  la fila, ya que eso necesitaría el mismo tratamiento de color sólido para
  competir con una regla CSS `:hover`, algo que no compensa la complejidad
  añadida para un estado transitorio.

### Cambiado

- **El tema forzado de un environment ahora fija solo la familia de tema,
  nunca el modo claro/oscuro.** Antes del cambio a `light-dark()` de arriba,
  el id de tema forzado de un environment (p. ej. `claude-dark`) implicaba un
  modo como efecto secundario de a cuál de los dos registros `Theme`
  enlazados apuntaba — así que entrar en un environment con un tema forzado
  podía cambiar en silencio la preferencia claro/oscuro actual del usuario.
  Familia y modo son ahora ejes independientes en el store de temas
  (`themeId` frente al nuevo `mode` global), y el override de un environment
  solo resuelve ya una familia — la preferencia de modo del usuario se
  mantiene sin cambios al cambiar de environment. Este es el comportamiento
  deseado a partir de ahora (un environment describe identidad de
  sesión/visual, no una preferencia ergonómica personal), no una regresión.

- **`state_file::write_atomic` queda extraída, y cada escritura del documento
  de origen pasa por ella.** `save_atomic` solo aceptaba nunca un nombre
  relativo al directorio de configuración — por diseño, ya que el aislamiento
  del canal canary del gotcha #26 depende de que esa sea la única vía de
  entrada —, así que no podía expresar una ruta en un recurso compartido. Un
  `fs::write` a secas ahí es exactamente la lectura truncada que
  `disappearance_is_trustworthy` existe para tapar: un publicador a mitad de
  guardado se ve idéntico a un administrador que ha borrado media plantilla.
  El documento se escribe en un fichero temporal **en el propio directorio del
  destino** (un `rename` solo es atómico dentro de un mismo sistema de
  ficheros, y un recurso compartido es otro volumen), se le hace `fsync`, y
  luego se renombra, guardando la revisión anterior al lado como
  `<nombre>.json.bak`. Los comandos de exportación puntual no cambian: escriben
  en un destino que el usuario acaba de elegir en un diálogo de guardado, que
  nadie más está leyendo a la vez.

- `ExportMetadata` ganó los campos opcionales `maintainer` / `revision` /
  `note`. Los tres son `skip_serializing_if`, así que un fichero de «Exportar
  perfiles…» o «Exportar entornos…» normal sigue siendo idéntico byte a byte a
  uno anterior a la 1.19 — lo mismo que le permite al editor reconstruir byte
  a byte un fichero que él mismo no escribió.

- **`ImportProgressBar` pasa a ser `common/ProgressBar`, con su leyenda como
  prop.** Tenía exactamente la forma que necesitaba la publicación de
  orígenes — una barra determinada, porque el trabajo es una derivación PBKDF2
  de 600 000 iteraciones por secreto y un spinner no da suficiente
  información para una docena de ellos —, y un tercer punto de uso fuera de
  `connection/` es precisamente el criterio que fija el gotcha #28 para
  `common/`. La publicación la alimenta desde su propio evento
  `huginndb://origin-publish-progress` en vez de reutilizar el de
  importación: un evento cuyo nombre dice «import», emitido por un publish, es
  un contrato de datos que miente, y una ventana haciendo las dos cosas a la
  vez nunca podría distinguirlas. No se emite nada cuando cada sobre viaja tal
  cual, que es el caso común y el instantáneo.

- **El filtro del panel Esquema busca en todas las conexiones abiertas a la vez,
  y dice dónde está mirando.** Había una única caja de filtro que en silencio
  solo se aplicaba a la conexión que estuviera *seleccionada* — a las demás se
  les pasaba una aguja vacía y se quedaban sin filtrar. La única señal de
  «seleccionada» es una línea de 2 px en la fila, y la selección se mueve sola
  cuando abres una pestaña o eliges una tabla desde la paleta de comandos. Así
  que con dos conexiones abiertas escribías, un subárbol se filtraba, el otro
  no, y nada lo explicaba. Lo reportaron varios usuarios.

  Ahora se busca en todas las conexiones vivas. Cada fila de conexión lleva su
  propio contador de coincidencias; la que no tiene nada que enseñar se pliega a
  una sola línea atenuada en vez de mostrar su árbol entero, y nunca se oculta —
  esa fila es justo lo que necesitas para conectarla o para acotar la búsqueda a
  ella. El pliegue que provoca una búsqueda es visual y temporal: no se escribe
  en los pliegues recordados del entorno, así que una búsqueda ya no puede
  dejarte conexiones plegadas que tú nunca plegaste. El filtro también se limpia
  al cambiar de entorno, cosa que antes no pasaba.

  **Acotar sigue siendo posible, solo que ahora se ve.** «Buscar solo aquí»
  sobre una conexión o una base de datos (su menú contextual, o el botón que
  aparece en la fila de conexión mientras buscas) pone un chip bajo la caja con
  el nombre de aquello a lo que has acotado. Se sale con la ✕ del chip, con
  Retroceso en una caja vacía o con Escape. Esto sustituye a un segundo ámbito
  invisible: desplegar una base de datos restringía la búsqueda a ella *y*
  colapsaba las demás, sin decirlo.

- **Escribir en ese filtro ya no abre conexiones a la base de datos.** Cada
  pulsación (con retardo) abría un pool de conexión por cada base que aún no
  hubiera leído — acotado a tres a la vez desde la 1.13.0, lo que lo hacía
  soportable, no correcto. Ahora la búsqueda mira lo que ya está cargado, y
  llegar más lejos es un botón que dice cuántas bases va a cargar. En un
  servidor que compartes con tu aplicación o con tu IDE, esa es la diferencia
  entre una búsqueda y una pequeña ráfaga de conexiones.

- **Un `0` junto a una conexión significa ya que la búsqueda no encontró nada
  ahí de verdad.** El árbol distingue «aún cargando», «nunca leído» (`—`, o
  `N+` cuando se ha leído parte del servidor), «fuera del ámbito actual» y un
  cero real. Un cero provisional es lo que hace que abandones una búsqueda que
  habría funcionado.

- **El panel Esquema vuelve a tener título, y dos líneas de aviso menos.** Sus
  dos acciones de árbol («Desconectar todas», «Conexiones a mostrar») eran
  botones con etiqueta que se truncaban a muñones ilegibles en los anchos a los
  que se suele arrastrar este panel; ahora son iconos con tooltip en la
  cabecera nueva, y la línea «mostrando N de M conexiones» se pliega en una
  marca sobre el icono que la cambia.

- **Tres atajos nuevos, en Ajustes → Atajos.** `Mod+Mayús+F` abre el panel
  Esquema si está plegado y enfoca el filtro; `Escape` dentro del panel limpia
  la búsqueda por capas (texto, luego ámbito, luego foco); y «Buscar solo en la
  conexión seleccionada» sale sin asignar, pero es asignable y se puede
  encontrar desde la paleta de comandos.

- **Desconectar una conexión avisa de que está trabajando, y «desconectar»
  tiene un solo icono en todas partes.** La ✕ de una fila de conexión (y la de
  la lista de la barra de estado) estaba mal por partida doble: una ✕ en una
  fila se lee como «quitar esta conexión», que es una acción distinta y mucho
  peor que cerrar su pool, y encima no daba ninguna señal mientras un cierre
  que puede tardar segundos estaba en curso. Las dos muestran ahora la misma
  marca de enchufe que lleva el botón «Desconectar todas», con un spinner
  mientras trabajan. El menú contextual y la paleta de comandos usaban un
  tercer icono para el mismo comando; se han igualado.

- **«Desconectar todas» ya no te hace esperar.** Cerraba las conexiones una
  detrás de otra, y una sola desconexión ya son varias idas y vueltas: el
  backend cierra por turnos cada pool por base de datos del servidor, esperando
  hasta cinco segundos en cada uno que haya dejado de responder. Así que un
  servidor inalcanzable obligaba a todos los sanos que iban detrás a aguantar
  su tiempo de espera primero. Ahora se cierran a la vez, y el botón enseña que
  está trabajando. El mismo comando desde el atajo de teclado o la paleta era
  una implementación aparte, más rápida, que dejaba el árbol obsoleto y sus
  pestañas apuntando a pools cerrados; los dos caminos son ya el mismo.

- **Borrar conexiones se confirma dentro de la app y dice qué se lleva por
  delante.** Antes había dos confirmaciones distintas: un `window.confirm` del
  sistema para una conexión y un diálogo propio para una multiselección, y
  ninguna mencionaba que borrar también elimina la contraseña del almacén de
  credenciales del sistema, las pestañas y el filtro de «bases de datos a
  mostrar» **en todos los entornos**, y los vínculos de JSON Schema fijados a sus
  columnas. Ahora un único diálogo sirve para los tres caminos y enumera
  exactamente lo que aplica a las conexiones elegidas: un fichero SQLite no
  guarda contraseña, una conexión sin túnel no tiene secreto SSH.

- **Una conexión publicada por un origen compartido ya no se puede borrar en
  lote.** Antes se podía seleccionar, y borrarla era peor que inútil: el id viaja
  en el fichero publicado, así que la siguiente sincronización la recreaba
  idéntica — después de haber eliminado tu contraseña local. Su casilla está
  ahora deshabilitada, con un tooltip que apunta a lo que sí funciona (quitar el
  origen en Ajustes). El backend también rechaza esos ids, así que ni la CLI ni
  el conector MCP pueden saltárselo.

- **Un borrado en lote es una sola operación en vez de N.** Borrar cuarenta
  conexiones reescribía `profiles.json` y `tab_state.json` cuarenta veces cada
  uno y emitía cuarenta eventos de cambio, con lo que cada ventana abierta releía
  y repintaba cuarenta veces. Ahora es una única pasada, e informa de lo que se
  ha saltado o no ha podido limpiar en lugar de tragárselo en silencio.

- El gestor de conexiones es más ancho (y su lista mide 320px en vez de 240px):
  el filtro de procedencia puso tres segmentos encima de filas que ya llevan un
  nombre, un distintivo de driver y una marca de origen, y los nombres se
  cortaban a mitad de palabra.

### Corregido

- **El doble clic sobre una celda de clave foránea necesitaba un segundo clic,
  ajeno a la celda, antes de que apareciera el combobox.** `GridRow` está
  envuelto en `React.memo` para que un clic solo vuelva a renderizar las filas
  que de verdad le afectan — cada trozo de estado que cambia rápido y puede
  alterar lo que muestra una fila se acota primero a «¿esto concierne a ESTA
  fila?» antes de llegar al componente, igual que ya hacía `inlineEditHere`.
  `fkEditCell` no tenía ese equivalente: el renderer de `cell` lo leía bien a
  través de una ref siempre actualizada, pero eso solo importaba una vez que
  React de verdad volvía a renderizar la fila, y el segundo clic de un doble
  clic solo actualiza `fkEditCell` — el primer clic ya había fijado
  `activeCell`/`selectedRowIndex`/`selectedCell` —, así que ninguna prop
  propia de esa fila cambiaba y `React.memo` se la saltaba sin más. El
  combobox solo aparecía cuando un clic ajeno, en otra celda o fila, forzaba
  el re-render por otra vía. `GridRow` recibe ahora una prop `fkEditHere`,
  acotada de la misma forma, solo para darle a `React.memo` algo que comparar.

- **El editor de celda se abría en modo JSON para casi cualquier columna,
  aunque fuera texto plano.** Un vínculo de JSON Schema (función de la 1.18)
  debía forzar el modo JSON cuando una columna tiene uno, para que el usuario
  obtenga validación en vez de una heurística que solo responde «json» cuando
  el texto resulta parsear. Pero `CellEditor` y `SideEditorPanel` decidían eso
  a partir de la mera presencia de un `CellBindingContext` — coordenadas de
  conexión/esquema/tabla/columna —, que es cierto para casi cualquier celda de
  una tabla real, tenga o no vínculo. `CellEditorBody` ya calculaba unas
  líneas más abajo la comprobación correcta (si hay un esquema realmente
  *resuelto* para esa columna, según la caché de `useJsonSchemas`) para
  decidir si adjuntar un esquema al modelo de Monaco; los dos puntos que
  deciden el lenguaje inicial usan ahora esa misma comprobación, en vez de
  solo las coordenadas.

- **El botón de «expandir» de una celda podía quedar fuera de la vista con el
  scroll en una columna ancha.** Se colocaba al final de la fila flex de la
  celda (`ml-auto`), así que en una columna redimensionada más ancha que el
  área de scroll visible el botón quedaba fuera de pantalla hasta que el
  usuario desplazaba esa celda concreta hasta el final. Los dos sitios donde
  aparece — el botón de la celda seleccionada sin editar y el editor en línea
  `CellInput` — lo hacen ahora `sticky` respecto al propio contenedor de
  scroll de la cuadrícula, la misma técnica ya usada para las columnas
  fijadas, con fondo opaco por el mismo motivo: `sticky` promociona el botón a
  su propia capa de composición, y un fondo translúcido dejaría ver el texto
  de la celda a través de él mientras se desplaza.

- **El contenido de una celda activa ancha se pintaba por encima de la columna
  del gutter fijada al hacer scroll, en vez de desaparecer detrás.** El `<td>`
  de la celda activa por teclado recibía `z-10` de forma incondicional para su
  anillo de foco, lo que ganaba al `z-[1]` de una columna fijada incluso
  cuando eran dos celdas completamente distintas — así que hacer scroll
  horizontal de una celda activa ancha deslizaba su texto y su fondo justo por
  encima de la columna de número de fila fijada, en vez de quedar oculta
  detrás, que es exactamente lo que `position: sticky` en una columna fijada
  debería garantizar. Un `position: relative` a secas (sin z-index) ya pinta
  por encima de los vecinos *no posicionados* sin importar el z-index, que era
  todo lo que el anillo necesitaba ahí; `z-10` queda ahora acotado al único
  caso que de verdad necesita ganarle al z-index propio de una columna
  fijada — que la propia celda activa esté fijada, para que su anillo siga
  visible sobre su propio fondo sólido.

- **Una conexión multibase con un subconjunto de «bases de datos a mostrar»
  podía enseñar un árbol vacío al buscar, sin explicación.** La comprobación de
  «¿seguimos cargando bases?» recorría todas las bases del servidor mientras el
  bucle que las cargaba de verdad aplicaba el subconjunto — así que con un
  subconjunto activo no terminaba nunca, y la línea «ninguna tabla coincide con
  el filtro» no podía aparecer.

- **Las bases de datos cargadas al buscar se vuelven a recordar.** La precarga
  del propio filtro las abría por la vía sin seguimiento, así que una pestaña
  abierta contra una base a la que habías llegado buscando (en vez de
  desplegándola) no se restauraba nunca: ni al reconectar, ni al cambiar de
  entorno, ni al reiniciar.

- **El árbol ya no filtra su contenido con una aguja distinta de la que decidió
  qué mostrar.** Cada explorador multibase aplicaba su propio retardo mientras
  al subárbol interior se le pasaba la aguja cruda, sin retardo, así que durante
  un cuarto de segundo después de cada pulsación las dos no coincidían.

- **Ctrl+V ahora funciona en celdas `BIT` de la cuadrícula de datos.** Antes
  era un no-op deliberado (issue #79): el texto pegado se enrutaba a
  `inlineEdit`, que una columna `BIT` renderiza como `BitInput` — un
  `<select>` fijo sin control de texto libre para recibirlo. Pegar sobre una
  celda `BIT` ahora normaliza el texto del portapapeles igual que hace el
  propio `BitInput` (`"1"`/`"true"` → `"1"`, `"0"`/`"false"` → `"0"`,
  cualquier otra cosa no vacía → `"1"`, vacío → `NULL`) y lo confirma
  directamente, saltándose el viaje de ida y vuelta si no cambia nada — el
  mismo patrón que ya usan el combobox de FK y el propio `onSelect` de
  `BitInput`. No hizo falta ningún cambio en el backend: `update_cell` ya
  resuelve el `CAST` de `BIT` de MySQL a partir del tipo de catálogo de la
  columna, no del valor que recibe.

- **Una conexión de MongoDB en `read-only` no podía leerse por MCP mientras la
  app de escritorio compartía sus pools.** `run_query` decidía qué clasificador
  usar buscando la conexión en el mapa de pools *del propio conector* — y ese
  mapa está vacío por diseño cuando la app es la dueña del pool (compartir
  pools, 1.13.0). Así que toda sentencia de MongoDB pasada por el bridge caía en
  la heurística de palabras clave SQL, donde `db.users.find({})` no coincide con
  `select`/`with`/`show`/`explain`/`pragma` y por tanto volvía como escritura.
  Un `find` normal se rechazaba en `read-only` y solo funcionaba desde `data`
  hacia arriba. La re-comprobación independiente de la app coincidía, por el
  mismo motivo equivocado.

  Ahora ambas llaman a un único clasificador,
  `db::classify::classify_statement`, que elige la gramática a partir del
  *texto* de la sentencia — el único dato que ambos puntos de control tienen
  siempre, y lo bastante puro para probarse sin servidor. Mientras la gramática
  mongosh no tenía DDL esto era solo excesivamente estricto; se habría
  convertido en una escalada de privilegios en cuanto existiera
  `db.coll.drop()`, porque ambos lados lo habrían dejado en `data`. Hay tests
  que fijan el nivel de cada operación en las dos capas.

- **`updateMany({})` y `deleteMany({})` por MCP se rechazan, igual que sus
  equivalentes SQL.** La guarda de relación entera exceptuaba a MongoDB, así que
  una conexión en `data` podía vaciar una colección en una llamada mientras
  `DELETE FROM users` se rechazaba en todos los niveles — mismo alcance,
  respuestas opuestas. La forma de optar por ello es la de SQL con `WHERE 1=1`:
  un predicado trivialmente cierto, p. ej.
  `deleteMany({_id: {$exists: true}})`. `drop()` queda fuera, a propósito: su
  alcance no es ambiguo y ya está detrás de `full`, exactamente como
  `DROP TABLE`.

- **La política de escritura MCP de una conexión compartida ya no se revierte en
  la siguiente sincronización.** La política es una decisión local sobre lo que un
  cliente de IA puede hacer en *esta* máquina, algo que quien publica un origen
  compartido no puede saber, pero la sincronización reemplazaba el registro
  completo y se la llevaba por delante. Poner una conexión compartida en «datos»
  funcionaba hasta el siguiente pull y volvía en silencio a solo lectura, lo que
  dejaba el panel MCP inservible para quien tiene todas sus conexiones en un
  origen. Todo lo demás de un perfil publicado lo sigue dictando el fichero.

- **Renombrar un origen compartido llega ya al resto de la app.** El registro de
  orígenes se leía una sola vez, en local, desde el panel de Ajustes que lo
  gestiona, así que nada más podía nombrar el origen detrás de una conexión — y
  «Sincronizar ahora» no refrescaba su propia marca de última sincronización, que
  se quedaba obsoleta hasta reabrir el panel. Ahora se cachea en un solo sitio y
  se invalida con un evento del backend, así que cualquier ventana ve un
  renombrado o una sincronización al instante.

## [1.18.0] — 2026-08-24

### Añadido

- **El visor de documentación ahora tiene secciones.** Una guía era un único
  panel de scroll, lo que dejaba las más largas prácticamente imposibles de
  consultar: `docs/MCP.md` son más de 400 líneas en un panel de 70vh, así que
  averiguar qué exige una herramienta obligaba a bajar a ciegas pasando por la
  configuración de cinco clientes hasta llegar a Seguridad. Cada guía abre ahora
  en una **portada** — su prosa de entrada más una tarjeta por sección — y la
  barra lateral es un árbol: las guías, con la abierta expandida en sus secciones,
  y una sección expandida en sus subsecciones. Al elegir una se muestra esa
  sección sola.

  La navegación se deriva de los encabezados del markdown, no de una lista
  mantenida al lado, y de ahí salen dos consecuencias que merece la pena decir.
  Añadir un `##` a una guía lo añade a la barra lateral sin tocar código. Y la
  barra lateral se traduce sola: el cuerpo en español lleva encabezados en
  español, así que elegir el idioma elige también las etiquetas.

  Los enlaces internos ya funcionan. Un `#ancla` salta a su encabezado — cambiando
  de página primero si el encabezado vive en otra — y un enlace relativo a otra
  guía incluida cambia a ella. Antes los dos se pintaban en color de marca, se
  subrayaban al pasar el ratón y no hacían absolutamente nada al pulsarlos; había
  ocho anclas y cinco enlaces entre guías en ese estado. Uno que apunte fuera del
  conjunto incluido (una hoja de ruta, `SECURITY.md`) abre ahora en GitHub en vez
  de ser un callejón sin salida. Un test comprueba que todas las anclas de todas
  las guías publicadas, en los dos idiomas, resuelven a un encabezado real, así
  que renombrar uno dejando huérfanos sus enlaces entrantes rompe el build en vez
  de pasar desapercibido.

  Arreglado de paso: cambiar de guía conservaba el scroll anterior, así que
  saltar desde el fondo de una guía larga a una corta te dejaba al final de ella.

- **Vistas por el conector MCP: leer, editar y eliminar.** Las vistas eran casi
  invisibles para un cliente de IA. `list_tables` informaba de `kind: "view"` y
  `describe_table` devolvía las columnas de una vista, pero nada podía leer su
  *cuerpo*, ni crear, redefinir o eliminar una — el único recurso era escribir a
  mano una consulta de catálogo por motor con `run_query`, y en MongoDB ni eso,
  porque su parser de `mongosh` no tiene vocabulario DDL y un pipeline
  almacenado era inalcanzable en las dos direcciones.

  Dos herramientas nuevas, y una existente ampliada, en los cinco drivers:
  - `describe_table` añade ahora un objeto `view` cuando la relación es una
    vista — `query` (el cuerpo del SELECT) en SQL, `viewOn` más el `pipeline`
    como texto fuente en MongoDB. Sin herramienta nueva para leer:
    `describe_table` ya conocía las vistas por la mitad de las columnas, así que
    el cuerpo va ahí.
  - `save_view` *(escritura)* crea, redefine o renombra una vista. Recibe solo
    `name` y `query`, y lee ella misma la definición actual para decidir cuál de
    las tres es y cómo expresarla en este motor — `CREATE OR REPLACE` en
    Postgres, `RENAME TABLE` en MySQL, borrar y recrear en SQLite,
    `createView`/`collMod` en MongoDB. Con `preview: true` devuelve las
    sentencias exactas sin ejecutarlas.
  - `drop_view` *(escritura)* elimina una, y rechaza cualquier cosa que no sea
    una vista.

  **El modelo de permisos no cambia** — sin eje nuevo, sin ajuste nuevo. Las dos
  herramientas de escritura son DDL, así que las dos exigen el nivel `full` que
  la conexión ya tenía. Y es la única respuesta coherente, no una preferencia:
  el `CREATE OR REPLACE VIEW` que podrías escribir a mano por `run_query` ya
  está clasificado como DDL, así que una conexión en `data` lo tiene rechazado,
  y una herramienta que permitiera el mismo cambio devolvería justo lo que el
  nivel acaba de negar. Queda una asimetría que conviene conocer: eliminar una
  *vista* pide `full` mientras que borrar *filas* solo pide `data` — la misma
  asimetría que ya existe entre `DROP TABLE` y `DELETE FROM`. El `preview` de
  `save_view` es una excepción de verdad, no un agujero: no ejecuta nada, así
  que está clasificado como lectura y funciona en cualquier nivel.

  MongoDB va por esas mismas dos herramientas en vez de tener su propio par. Un
  cliente de IA no puede ver la diferencia desde la salida de `list_tables`, y lo
  que quiere es una herramienta por verbo; el pipeline viaja como texto fuente y
  lo parsea únicamente el único parser que tiene el producto, así que un
  `ObjectId(...)` dentro de un `$match` sigue dando la vuelta como constructor y
  no degradado a cadena.

  De paso, SQL Server ganó la capacidad de leer la definición de una vista; solo
  *crearla* sigue sin estar soportado ahí. Ver [`docs/MCP.md`](docs/MCP.md).

- **Un sistema de notificaciones propio, en lugar de la configuración por
  defecto de la librería.** Las notificaciones eran la librería de toasts
  montada tal cual: cuatro segundos, abajo a la derecha, una tarjeta
  blanca/negra fija que `index.css` intentaba recolorear desde fuera con unas
  60 líneas de `!important`, y un tick pintado con el azul de marca, de modo
  que una confirmación se leía igual que una acción. Ahora cada decisión
  visual es de `NotificationCard`, que se dispara a través de la nueva fachada
  `lib/notify`: la librería se queda solo como transporte (apilado, las seis
  posiciones, descartar arrastrando, temporizadores, foco) y, al marcarse un
  toast `jsx` como `data-styled="false"`, deja de pintar nada, así que el
  bloque de `!important` desaparece en vez de crecer. La tarjeta es una
  superficie del tema: `popover` sobre `border` con radio de 10 px, un riel
  semántico de 3 px con el mismo grosor en todos los estados (el color es la
  única variable), un medallón de icono de 28 px, la escala `2xs`/`3xs`, la
  rampa de sombras `elevation-*` y un hairline de 2 px que se vacía con el
  tiempo restante y se congela mientras el puntero esté sobre la pila.
  `success` usa por fin `--success` en lugar de `--brand`, e `info` es el
  único estado que gasta el azul de marca.

- **Al pulsar el nombre del archivo en una notificación de exportación se abre
  el explorador con el archivo seleccionado.** Antes la ruta se incrustaba en
  la frase traducida (`"Exportado en {{path}}"`), lo que la volvía imposible
  de seleccionar, copiar o abrir, que es justo lo único que se quiere de ella.
  Un nuevo tipo `file` separa el título de la ruta, dibuja el nombre como un
  control real (`api.revealItemInDir`, sobre el comando `reveal_item_in_dir`
  del plugin `opener`, ahora permitido en `capabilities/default.json`) y
  ofrece «Abrir carpeta» y «Copiar ruta», con la carpeta contenedora debajo.
  Lo heredan todas las exportaciones: tabla, filas filtradas, colección, base
  de datos, perfiles de conexión, entornos, esquemas JSON y temas. Si el
  archivo se movió o se borró, el nombre queda tachado y salta un aviso, en
  vez de un botón que no hace nada en silencio.

- **Las repeticiones se agrupan en una sola notificación con contador.**
  Guardar varias filas apilaba siete tarjetas idénticas; ahora las
  notificaciones iguales que se levantan dentro de una ventana de cinco
  segundos se funden en una, contada, y la política de agrupado vive en un
  único sitio para que la tarjeta en pantalla y la fila del historial no
  puedan contar cosas distintas.

- **Un historial de notificaciones tras una campana en la barra de herramientas.**
  La misma tarjeta comprimida a una fila, agrupada por día, con cuenta de no
  leídas y con cada entrada de archivo todavía pulsable, así que una
  exportación de hace veinte minutos está a un clic del explorador. En memoria
  y por ventana a propósito: es material efímero de la sesión, así que no
  merece un archivo de estado ni un sitio en `prefs.json` (que se reescribe
  con cada `Ctrl`+rueda en la cuadrícula), y una segunda ventana que heredara
  las notificaciones de la principal estaría atribuyéndose trabajo que no hizo.

- **Ajustes → Notificaciones**, sección nueva: la posición como una rejilla de
  seis ventanas en miniatura en lugar de un desplegable (la elección es
  espacial), la duración como preajustes más el valor en milisegundos, si los
  errores esperan a que los cierres, cuántas se ven a la vez, expandir al
  pasar el ratón, la densidad de la tarjeta, el tope del historial y si se
  muestra la campana. Cada fila es direccionable desde la paleta de comandos,
  y la vista previa de la sección dispara una notificación *real*: juzgar seis
  segundos frente a cuatro es exactamente lo que un dibujo no permite.

### Corregido

- **El explorador de esquema de SQL Server nunca llegaba a cargar las columnas
  de una tabla — se quedaba en el skeleton de carga para siempre, sin ningún
  error, en todas las tablas, en todos los servidores.** El fix del timeout de
  conexión de más abajo (sigue siendo correcto, sigue mereciendo la pena) no
  era, en realidad, lo que le pasaba a la mayoría: este es un bug distinto y
  más fundamental en el mismo driver, y explica los reportes de "SQL Server
  simplemente no carga el esquema" en conexiones que por lo demás funcionaban
  perfectamente — ver datos de tablas, ejecutar consultas, todo lo demás
  funcionaba; solo la lista de columnas del árbol nunca aparecía.

  `tiberius::Row::get::<T, _>` es `self.try_get(idx).unwrap()` — hace *panic*
  cuando la variante real de `ColumnData` de la columna no coincide con lo
  que acepta el `FromSql` de `T`, en vez de devolver `None`. El helper `i()`
  de `db::mssql::schema` (usado para leer una columna entera del catálogo de
  ancho desconocido) probaba `i64` → `i32` → `i16` → `u8` con
  `.get(...).or_else(...)`, que se lee como un ensanchamiento gradual pero no
  lo es: el primer intento que no encaja hace panic antes de que la cadena de
  `or_else` llegue a ejecutarse nunca. `sys.columns.max_length` es `smallint`,
  así que `raw_columns` (por donde pasa toda llamada a `list_columns`/
  `table_structure`) hacía panic en `i(r, "max_length")` para la primera
  columna de la primera tabla, siempre — una lectura `i64` nunca puede tener
  éxito contra un `ColumnData::I16`. `list_tables` no se veía afectada solo
  porque su propio uso de `i()` (las estadísticas de filas/bytes) resulta ser
  genuinamente `bigint`, que es por lo que la lista de tablas en sí siempre
  cargaba bien. El `auth_type` de `list_users`
  (`sys.database_principals.authentication_type`, un `tinyint`) tenía el
  mismo panic latente, rompiendo la lista de usuarios del panel de Seguridad
  por el mismo motivo.

  Un panic dentro de la tarea asíncrona de un comando de Tauri nunca llega
  al frontend como una promesa rechazada — la llamada `invoke()` del lado JS
  simplemente se queda pendiente para siempre, indistinguible de un cuelgue,
  que es exactamente por qué esto parecía un problema de timeout y no un
  crash. También explica por qué nada en la batería de tests existente lo
  detectó: el error de lógica de `i()` solo se manifiesta contra un
  `tiberius::Row` real ya decodificado, algo que ningún test unitario
  construye (los campos de `Row` son privados al crate `tiberius`).

  `i()` ahora usa `try_get` y descarta el `Err` de un ancho que no encaja
  (`.ok().flatten()`) en vez de dejar que haga panic, así que la cadena de
  fallback ahora sí cae al siguiente ancho como se pretendía originalmente.

- **SQL Server era el único driver cuyo explorador de esquema podía quedarse
  colgado para siempre en el skeleton de carga, sin ningún error y sin forma
  de reintentar.** Todos los drivers basados en `sqlx` (Postgres/MySQL/SQLite)
  reciben gratis un timeout a nivel de conexión: `db::pool::tuned()` fija
  `.acquire_timeout(ACQUIRE_TIMEOUT)` en sus `PoolOptions`, así que incluso un
  `connect()` inicial contra un host inalcanzable falla a los 30s. `tiberius`
  no tiene ningún ajuste equivalente, y el propio `connect()` de `db::mssql`
  nunca añadió uno: ni el TCP connect llano ni la ida y vuelta UDP del SQL
  Browser (`Reach::Browser`, usado para instancias con nombre) tienen ningún
  timeout a nivel de sistema operativo, así que un host que descarta paquetes
  en silencio — un firewall, o un Browser parado sin puerto estático de
  respaldo configurado — colgaba el intento de conexión indefinidamente.

  Esa carencia era invisible para las consultas normales, que ya corren
  dentro del wrapper `with_timeout` de `commands::schema`
  (`OPERATION_TIMEOUT`, 20s). No era invisible para una **vista por base de
  datos**: el explorador multi-base la abre de forma perezosa, vía
  `commands::connection::ensure_database_view`, y cada comando de esquema
  (`list_databases`/`list_tables`/`list_columns`/`list_indexes`) llama a eso
  *antes* de entrar siquiera en su propio bloque `with_timeout`. Así que la
  primera vez que se expandía una base de datos en el árbol — o la primera
  consulta después de que el reaper de pools cerrara una sesión inactiva —
  SQL Server podía colgar el comando entero sin ningún límite, mientras que
  el intento de conexión equivalente de cualquier otro driver ya tenía uno
  vía `acquire_timeout`. Desde la interfaz esto se veía exactamente como el
  reporte: el árbol de esquema atascado en su skeleton de carga para
  siempre, sin error y sin forma de reintentar, solo con SQL Server.

  `db::mssql::connect` pasa ahora por un pequeño wrapper
  `bound_by_acquire_timeout` que usa el mismo `ACQUIRE_TIMEOUT` de los pools
  de `sqlx`, convirtiendo una conexión colgada en un error `OperationTimedOut`
  claro en vez de un skeleton permanente. Esto cubre tanto la primera
  conexión de una vista por base de datos como cualquier reconexión
  posterior tras el cierre de una sesión por el reaper de inactividad, ya
  que todo camino que abre una sesión TDS nueva pasa por
  `MsSqlPool::acquire`, que es el único sitio desde el que se llama a
  `connect`.

- **Eliminar una «vista» de MongoDB cuyo nombre era en realidad una colección
  borraba todos sus documentos.** MongoDB guarda vistas y colecciones en el
  mismo espacio de nombres, y eliminar cualquiera de las dos es la misma llamada
  `drop` — así que `db::mongo::aggregation::drop_view` era un
  `collection(name).drop()` sin comprobación alguna, y apuntarlo a una colección
  real destruía todos sus documentos informando de éxito. En la práctica era
  soportable porque el único llamante era el explorador de esquema, donde el
  usuario había pulsado una fila que el árbol ya sabía que era una vista. Deja
  de serlo en el momento en que un llamante puede pasar un nombre que solo ha
  adivinado, que es exactamente lo que supone exponer la gestión de vistas por
  el conector MCP — de ahí que la comprobación llegue antes de ese trabajo y no
  junto a él.

  `view_presence` resuelve ahora un nombre a uno de tres estados — ausente, una
  colección, o una vista con su definición ya parseada — en una sola ida y
  vuelta de `listCollections`, y `drop_view` rechaza todo lo que no sea el
  tercero. La comprobación de tipo en sí (`spec_is_view`) es una función pura
  para que se pueda testear sin servidor; trata un spec sin campo `type` como
  una *colección*, porque ese campo solo existe desde MongoDB 3.4 y una
  respuesta que no se reconoce tiene que caer del lado seguro, no del
  destructivo. `read_view` se expresa ahora sobre el mismo helper en lugar de
  repetir la comprobación.

  Un nombre que no existe es ahora un error, en vez del éxito idempotente y
  silencioso de MongoDB. Eso deja al driver coherente con los otros cuatro, que
  construyen todos un `DROP VIEW` pelado sin `IF EXISTS`, y hace que un nombre
  mal escrito lo diga en lugar de informar de que funcionó.

- **Crear un índice de MongoDB dejando el campo «Nombre» en blanco siempre
  fallaba.** El diálogo documenta ese campo vacío como «el servidor lo deriva
  de las claves», pero eso nunca funcionó: `NewMongoIndexSpec::to_document`
  simplemente omitía la clave `name` cuando estaba en blanco, asumiendo que el
  servidor lo derivaría igual que hace el helper tipado
  `Collection::create_index()`. No lo hace: esta app envía los índices
  deliberadamente a través del comando en crudo `createIndexes` en vez de ese
  helper (así una recreación puede validar el spec antes de tocar el
  servidor), y ese comando exige que `name` esté presente. La convención de
  nombre `field_1_other_-1` ya existía en la ruta de lectura (`spec_to_info`)
  pero nunca se aplicaba al escribir. Ahora ambas rutas comparten esa lógica
  mediante un nuevo helper `default_index_name`, así que un nombre en blanco
  siempre resuelve al mismo nombre que el índice acabará teniendo.

- **Una actualización masiva («Actualizar filas que coincidan») sobre una
  columna `BIT` de MySQL fallaba con `1406 (22001): Data too long for
  column`.** Es el mismo fallo que ya se corrigió para la edición de una
  celda y la inserción: un valor de texto plano como `"0"` se guarda como el
  byte ASCII `0x30`, no como el entero 0, a menos que el placeholder se
  envuelva en `CAST(? AS UNSIGNED)`. `update_cell_inner` e `insert_row` ya
  aplicaban ese cast (y su equivalente para SQL Server,
  `CONVERT(varbinary(max), ?, 1)`, en columnas binarias), pero la
  actualización masiva tenía su propio constructor de la cláusula `SET`
  (`build_update_statement` en `commands/bulk.rs`) que nunca recibió ese
  tratamiento y vinculaba cada columna como texto plano sin mirar el tipo.
  Ahora aplica el mismo cast por columna (más el fallback al catálogo cuando
  la caché de esquema está desactualizada), compartido tanto por la vista
  previa como por la aplicación real.

- **La pestaña de consulta contra una conexión MongoDB se titulaba
  `query.sql` y se sembraba con un comentario `-- ...` de SQL**, aunque esa
  pestaña ejecuta en realidad un comando `mongosh`-style acotado
  (`db.<coleccion>.<metodo>(...)`), no SQL — lo que llevó a confusiones reales
  en el equipo al tratarla como si fuera una superficie SQL. Una nueva
  pestaña de consulta contra MongoDB ahora se titula `query` y se siembra con
  un comentario `//`, acorde a la gramática real (ambos casos detectan el
  driver mediante `resolveConnectionDriver`); el título de respaldo al
  restaurar sesión y la etiqueta de idioma en la barra inferior del editor
  siguen la misma regla. La pestaña sigue ejecutando el mismo motor
  `mongosh`-style y conserva el modo de lenguaje `sql` de Monaco (con su
  autocompletado/CodeLens ya conscientes del driver) — solo cambió el
  nombrado, no la superficie de edición.

- **Un origen compartido con secretos cifrados guardaba lo que no debía en el
  llavero del sistema.** `sync_origin` escribía el *sobre* AES-256-GCM en base64
  como si fuera la contraseña, así que todo perfil importado desde ese origen
  fallaba al conectar con un error de autenticación del driver — y la contraseña
  real no era recuperable a partir de ahí. La ruta de descifrado ahora es la
  misma que usa el importador de perfiles (`transfer::land_secrets`), que nunca
  guarda un secreto que no ha podido descifrar; un origen cuya passphrase no
  está disponible deja simplemente el perfil pidiendo contraseña, que es el
  comportamiento documentado (la passphrase viaja por otro canal). Tres tests de
  regresión lo cubren sin tocar el llavero.

- **Eliminado un comando IPC inalcanzable que podía leer cualquier entrada del
  llavero.** `load_password(account)` estaba registrado pero no se llamaba desde
  ningún sitio de la app; aceptaba un nombre de cuenta arbitrario y devolvía el
  secreto guardado. Nada en HuginnDB necesita esa forma — la ruta de conexión
  resuelve su propia clave —, así que el comando y su módulo se han borrado en
  lugar de restringirse.

- **El editor de colores del tema salía entero en inglés**, con cualquier idioma
  seleccionado: los 26 nombres de color y los 4 títulos de grupo eran cadenas
  fijas en `lib/themes.ts`. Ahora son claves i18n, en ambos idiomas.

- **Los números y las fechas seguían el idioma del sistema operativo en vez del
  elegido en Ajustes.** Doce llamadas a `toLocaleString()` no pasaban locale, así
  que una interfaz en español sobre un sistema en inglés mostraba `1,234` y
  `8/21/2026`. Ahora pasan por `formatNumber` / `formatDateTime` / `formatTime`,
  que leen `ui.language`.

- **Importar un entorno ocultaba sus propias conexiones cuando un perfil en
  conflicto se resolvía como «Omitir».** El perfil omitido no aparecía en el mapa
  id-original → id-nuevo, así que el filtro `visible_connections` del entorno
  nuevo lo descartaba, y cualquier binding de JSON Schema que lo apuntara quedaba
  desactivado aunque la conexión estuviera ahí desde el principio. Un perfil
  omitido ahora se mapea a sí mismo.

- **Cada arranque congelaba la ventana durante todo el sync del origen
  compartido — varios segundos de «No responde» con un conjunto de perfiles
  real.** Dos causas, ambas corregidas. `sync_origin` era un comando Tauri
  *síncrono*, así que se ejecutaba en el hilo principal: el que bombea la
  ventana, y el que además tenía que leer el fichero de un recurso de red. Y
  volvía a plantar en el llavero **todos** los secretos publicados en **cada**
  sync, hubiera cambiado algo o no, a ~600 000 rondas PBKDF2 por hueco. Un
  origen que publica treinta conexiones con túnel gastaba así decenas de
  millones de rondas SHA-256 en el hilo de UI en cada inicio, y otra vez cada
  cuatro horas.

  Ahora el comando es `async` con el cuerpo en `spawn_blocking`, y se guarda una
  huella del texto cifrado de cada perfil para reconocer y saltar un secreto que
  no ha cambiado. El salto necesita las dos mitades para ser seguro: solo la
  huella dejaría para siempre sin restaurar una entrada de llavero que alguien
  borró, y solo la comprobación de presencia no detectaría nunca una contraseña
  rotada. Con el conjunto donde se encontró (29 conexiones del origen, 26 de
  ellas con túnel), el segundo arranque pasó de un núcleo saturado y la ventana
  congelada a 0 % y ventana viva.

- **Un `accept()` fallando en el puente MCP podía dejar un núcleo girando
  indefinidamente.** El bucle del listener reintentaba sin condiciones, con el
  argumento de que «un accept fallido es transitorio», y descartaba el error sin
  registrarlo. Eso vale para un cliente que desaparece a mitad del saludo, pero
  no para el agotamiento de descriptores (`EMFILE`/`ENFILE`), que es la razón de
  manual por la que `accept()` falla repetidamente y que no se resuelve hasta
  que algo ajeno libera un handle. Ahora los reintentos escalan hasta un tope de
  un segundo tras unos pocos inmediatos —así el caso transitorio no cambia y el
  persistente no cuesta nada— y el fallo se informa en la Consola en vez de
  desaparecer. Latente, no observado en uso real: apareció al diagnosticar la
  congelación de arranque de arriba.

- **Un documento SQL se dividía mal en sentencias a partir de su primer literal
  de texto.** El divisor que alimenta el CodeLens «▶ Ejecutar» por sentencia
  cerraba una cadena entrecomillada y, en la misma pasada, la reabría con ese
  mismo carácter de cierre: todo lo que iba después de `'…'`, `"…"` o `` `…` ``
  quedaba como una cadena sin cerrar y ningún `;` posterior era un límite. Un
  script de dos sentencias mostraba un solo lens abarcando ambas, e importar un
  volcado `.sql` (que pasa por el mismo divisor antes de `execute_batch`)
  enviaba el fichero entero como una única sentencia, que el protocolo
  preparado rechaza. Los cuerpos con comillas de dólar y los comentarios nunca
  se vieron afectados: solo a los tres caracteres de comilla les faltaba el
  `continue` que los demás contextos ya tenían.

- **Un `;` suelto contaba como sentencia.** `;;SELECT 1;` producía tres, dos de
  ellas ofrecidas para ejecutar por el CodeLens, pese a que el divisor documenta
  que las sentencias vacías se descartan: un punto y coma solo no es espacio en
  blanco, así que recortar no lo detectaba.

- **Al importar un tercer perfil con el mismo nombre se numeraba `(3)`, saltándose
  el `(2)`.** La escalera de renombrado del importador de perfiles reutilizaba un
  único contador para los dos peldaños, así que la secuencia era `nombre`,
  `nombre (imported)`, `nombre (3)`, `nombre (4)`, … Ahora coincide con la del
  importador de JSON Schemas —`nombre (2)` tras `nombre (imported)`— porque ambos
  llaman a la misma función.

- **Los conflictos al importar entornos vienen por defecto en «Omitir» y no en
  «Renombrar»**, igual que en el importador de perfiles. Reimportar tu propio
  export acumulaba `nombre (imported)`, `nombre (2)`, … en cada vuelta; el paso
  de conflictos se sigue mostrando, así que un entorno realmente distinto está a
  un clic de Renombrar u Sobrescribir.

- **«Copiar como ▸ SELECT» no escapaba los delimitadores dentro de un nombre de
  tabla o columna**, generando un fragmento que no parseaba. Ahora usa el mismo
  quoting que los demás formatos de portapapeles.

- **`profiles.json` era el único fichero de estado que se escribía sin
  temporal + rename**, así que un fallo a medias podía dejar truncadas todas las
  conexiones guardadas — y con ellas las entradas del llavero, los bindings de
  JSON Schema y los enlaces a orígenes que se apoyan en esos ids. Ahora todos los
  ficheros de estado JSON pasan por un único escritor atómico
  (`src-tauri/src/state_file.rs`).

- **Tres brazos de `match` que habrían tratado mal en silencio un driver o un
  operador de filtro nuevo.** `empty_table` caía en el `TRUNCATE` de Postgres
  para cualquier caso no listado (SQL Server habría ejecutado una sentencia que
  acepta con otra semántica, y MongoDB una que no tiene), y los brazos de
  comparación y `LIKE` del constructor de filtros caían en `<=` y `EndsWith`. Los
  tres deletrean ahora todas las variantes, así que añadir una es un error de
  compilación.

### Cambiado

- **Las notificaciones duran 6 s en lugar de 4 s y los errores esperan a que
  los cierres.** Los cuatro segundos eran el valor por defecto de la librería
  y nunca daban para leer una ruta o un mensaje del driver; los tipos que
  traen algo que hacer reciben ahora un múltiplo de la duración configurada
  (un aviso el doble, una notificación de archivo el cuádruple, con tope de
  30 s) y un error se queda hasta que se cierra, porque casi siempre trae algo
  que copiar, reintentar o reportar. Ambas cosas son preferencias, y un error
  incluye además una acción «Copiar error» sin coste alguno.

- **Interno: una pasada por todo el proyecto sobre lógica duplicada y
  responsabilidades mal colocadas.** Sin cambios de comportamiento más allá de
  las correcciones de arriba. Lo que merece la pena saber:
  - `db/exec.rs` — la contraparte de ejecución de `db::sql::Dialect`. Doce sitios
    repetían el mismo `match pool { … }`, dos de ellos byte a byte, y uno era una
    reinserción de un decodificador que ya existía 200 líneas más arriba.
  - La introspección de catálogo de Postgres/MySQL/SQLite sale de
    `commands/schema.rs` (1559 → 769 líneas) hacia
    `db/{postgres,mysql,sqlite}/`, replicando `db/mssql` y `db/mongo`. Los 17
    `unreachable!()` han desaparecido.
  - `state_file.rs`, `AppState::pool_for`/`mongo_for`, `Dialect::quote_ident` y
    `Dialect::truncate_stmt` sustituyen entre 9 y 10 copias a mano cada uno.
  - `tab_state::mutate` sustituye catorce cuerpos escritos a mano con el mismo
    patrón —tomar el bloqueo de escritura, mutar, clonar el blob entero,
    soltar el guard, guardar— en `commands/{prefs,origins,connection}.rs`. El
    clonar-y-soltar no es incidental: el guardado hace E/S de disco, y mantener
    el bloqueo durante ella dejaría bloqueado a cualquier otro lector mientras
    dura la escritura.
  - `commands::ensure_view` / `commands::entry_sink` sustituyen el prólogo de
    siete líneas con `ensure_database_view` que abría cuarenta y cinco comandos
    de nueve módulos, ocho de los cuales además construían a mano el sumidero de
    log de la Consola. Olvidarlo no se nota hasta que una vista de base de datos
    lleva inactiva lo bastante como para que el segador la cierre, así que
    reducirlo a una línea vale más que las 240 líneas que quita.
  - `log_bus::log_sql_sink` es el único sitio donde se construye una entrada SQL
    de la Consola. `commands::bulk` y `db::mongo::query` rehacían a mano la misma
    cadena de seis campos, dos veces cada uno —una por rama del `match`
    `Ok`/`Err`—, mientras `commands::query` se documentaba como la única ruta de
    log. El helper baja junto a `LogEntry`, que es lo que permite usarlo desde la
    capa `db` sin depender hacia arriba de `commands`.
  - `TableQuery` / `TableScan` / `TableFilter` sustituyen los nueve parámetros
    sueltos que el navegador de tablas enhebraba por `fetch_table_data`,
    `count_table_rows`, `export_table_rows`, sus núcleos `_inner` y cuatro
    puntos de entrada de MongoDB. Con ellos se van seis de los catorce
    `#[allow(too_many_arguments)]`. La carga útil IPC no cambia en el cable (el
    predicado va con `#[serde(flatten)]`), y cuatro tests de deserialización
    fijan el JSON exacto que envía la rejilla: un campo que exista a un lado de
    esa frontera y no al otro se descarta sin decir nada.
  - Cuatro primitivas más de la capa de drivers que estaban copiadas en vez de
    compartidas: `db::values::hex` (tres copias privadas idénticas byte a byte,
    cada una con un comentario diciéndolo), `db::exec::ping` (el latido del
    keepalive y la sonda de conexión enumeraban cada uno los cinco drivers),
    `db::mysql::{is_bit_type, bit_cast, normalize_bit_value}` (el razonamiento
    de escritura de `BIT` del gotcha #15, deletreado en seis sitios) y
    `Dialect::rename_stmt` (`rename_table` y `rename_view` solo se diferenciaban
    en la palabra clave de Postgres y en una palabra de un mensaje de error).
  - La fontanería de importación/exportación: `transfer::{check_meta, metadata,
    save_export, disambiguate_name}` sustituyen los mismos cuatro pasos escritos
    una vez por cada tipo de transferencia (perfiles, entornos, JSON Schemas), y
    `resolve_ssh_secret` se comparte con el conector MCP en lugar de repetirse
    allí.
  - Las ocho tools de solo lectura del conector MCP comparten un mismo cuerpo
    `read_tool` (reabrir un pool segado, resolver el destino por base de datos de
    MongoDB, una petición al puente, serializar). Las de escritura conservan el
    suyo: su comprobación de política va entre dos de esos pasos, y la doble
    comprobación entre las dos capas es deliberada. `resolve_mongo_target` deja
    además de hacer un viaje de ida y vuelta por el puente para preguntar «¿esto
    es MongoDB?» en las cuatro tools que no pasan schema e ignoran la respuesta.
  - `QueryResult::{rows, affected, with_total, with_truncated, with_row_types}`
    sustituyen nueve literales de struct que repetían los mismos siete campos, y
    `src-tauri/src/testkit.rs` alberga el fixture de `ConnectionProfile` del que
    seis módulos de test tenían copia privada: así, un campo nuevo en cualquiera
    de los dos es una edición y no nueve o seis.
  - Frontend: `useImportWizard` (tres diálogos), `useAsyncSubmit` (diez),
    `OverlayPalette` + `useListNavigation` (paleta de comandos y conmutador de
    pestañas), `lib/schedule.ts` (tres debounces, dos sondeos), `RefreshButton`
    (cinco), más `lib/grid/pagination.ts` y `lib/grid/exportTable.ts`.
  - `PrefId` se deriva ahora de `Preferences`, así que un id de «ir a este
    ajuste» que no nombre una preferencia real es un error de compilación en vez
    de un salto muerto en silencio.
  - Borrado código muerto: `ConnectPasswordDialog` (92 líneas, ningún
    importador) y sus claves i18n, `useSavedQueries.byTag`, tres constantes sin
    usar y la dependencia `async-trait`.

- **Interno: los cinco ficheros que habían pasado de mil líneas quedan divididos
  por responsabilidad.** Sin cambios de comportamiento más allá de las
  correcciones de arriba. `SchemaExplorer.tsx` 2842 → 73 (sus ocho diálogos a
  `schema/dialogs/`, cada nivel del árbol a su propio fichero,
  `ConnectionActionsMenu` a `components/connection/`, junto al árbol que lo
  renderiza); `DataGrid.tsx` 3592 → 1301 (fuera `GridRow`, los chips de filtro,
  la caja de búsqueda, la fila borrador y `GridToolbar`; la selección de filas,
  el dimensionado de columnas, el zoom con Ctrl+rueda, la lectura de
  preferencias, la edición de celdas, la navegación por teclado y las
  definiciones de columna a hooks bajo `lib/grid/`);
  `ConnectionDialog.tsx` 1761 → 1267 y sus 41 `useState` a 11 (fuera el raíl y
  el modelo del formulario); `TabbedArea.tsx` 1082 → 390 (fuera la cabecera de
  pestaña y la pantalla vacía); `App.tsx` 820 → 530 (fuera el manejo de intents
  de línea de comandos). Dos órdenes se han preservado a propósito y quedan
  documentados donde se aplican: la secuencia del efecto de arranque y los
  contratos de memoización de `GridRow` y de la cabecera de pestaña.

- **Vitest está montado para el frontend** (`pnpm test`) con tests de
  caracterización de los módulos puros de `lib/` y de cada hook extraído, y el CI
  lo ejecuta junto a los trabajos existentes de typecheck y Cargo. 160 tests en
  18 ficheros, incluidos el divisor de sentencias SQL (en el que los tests
  encontraron los dos bugs de arriba), el matcher de puntuación de la paleta de
  comandos y la división `HOST\INSTANCE` de SQL Server, cuyo gemelo autoritativo
  en Rust sí tenía tests desde el principio.

## [1.17.0] — 2026-08-20

### Añadido

- **Una barra de progreso determinista para los diálogos de importar
  perfiles/entornos**, alimentada por un nuevo evento
  `huginndb://import-progress` emitido desde `apply_profile_imports`
  (`src-tauri/src/commands/connection.rs`) una vez por cada perfil a medida
  que recorre la lista exportada. Ahora que la importación corre fuera del
  hilo principal (ver el arreglo del «No responde» más abajo), la ventana se
  mantiene receptiva durante una importación grande, pero el botón
  deshabilitado no daba ninguna pista de si estaba a punto de terminar o
  atascado — una preocupación real ahora que la operación puede tardar
  legítimamente decenas de segundos. `ImportProgressBar`
  (`src/components/connection/dialogs/`) muestra «N de total» y la comparten
  tanto `ImportProfilesDialog` como `ImportEnvironmentDialog`, cada uno
  suscribiendo su propio `listen()` durante la duración de su llamada a
  `doImport`.

- **Acciones masivas «Marcar todo como: …» sobre la lista de conflictos** en
  ambos diálogos de importación (`ConflictBulkActions`,
  `src/components/connection/dialogs/`), para que resolver un lote con
  decenas de perfiles en conflicto — justo lo que produce una importación de
  varios entornos — ya no signifique pulsar Mantener ambos/Sobreescribir/
  Omitir fila por fila. Fija la resolución de todos los conflictos de una vez
  a través del mismo mapa `resolutions` que ya escriben los botones por fila,
  así que no hizo falta tocar nada aguas abajo.

- **Una biblioteca de esquemas JSON definidos por el usuario, y vínculos por
  columna que hacen que el editor de celda entienda de esquemas.** Un HuginnDB
  usado como almacén de configuración acaba con columnas `json`/`jsonb`/`TEXT` que
  contienen documentos de cientos de líneas con un contrato real, aunque no escrito
  en ninguna parte, y el editor de celda trataba todos ellos como JSON anónimo:
  resaltado de sintaxis, una insignia de válido/no válido y nada más. Ahora
  mantienes una biblioteca de esquemas (un nombre, una descripción opcional y el
  documento tal y como lo escribiste, en un `json_schemas.json` propio) más una
  lista aparte de vínculos que dicen a qué columnas se aplica cada uno. Vincula uno
  y Monaco empieza a completar nombres de propiedad, a sugerir valores de
  enumeración, a mostrar la `description` de cada propiedad al pasar el ratón y a
  subrayar los valores que no encajan. El autocompletado y la documentación al
  pasar el ratón son lo que cambia una jornada de trabajo; la validación es la
  mitad más pequeña.

  La biblioteca es **global, no está adscrita a un entorno**, y eso es una lectura
  deliberada de lo que significa un vínculo. Un vínculo dice «la columna de esta
  tabla tiene esta forma», que es un hecho sobre el *servidor*, no sobre si estás
  mirando Producción o Staging. Adscribirla a un entorno daría a la misma tabla un
  esquema en un entorno y no en otro, que es el bug de `visible_databases` (gotcha
  #27) por tercera vez. También vive en un fichero propio y no en `prefs.json`,
  porque el cuerpo de un esquema real son 50–200 KB y `prefs.json` se reescribe en
  cada `Ctrl`+rueda del grid.

- **La validación nunca impide guardar, por construcción.** Nada en la ruta de
  guardado lee los marcadores, y los diagnósticos están configurados con severidad
  de aviso para que una violación ni siquiera *parezca* que bloquea. La base de
  datos es la autoridad; un esquema es una ayuda. El día que el esquema de alguien
  esté ligeramente mal, seguirá pudiendo editar sus propios datos.

- **Una cascada de más-específico-gana, implementada una sola vez, en Rust.** Un
  vínculo nombra una conexión, un esquema/base de datos, una tabla y una columna;
  todos los ejes menos la columna admiten «cualquiera», y tabla y columna aceptan
  un glob simple con `*`, así que una regla puede cubrir `*_json` en todo un
  servidor o exactamente una columna de una tabla. La especificidad va
  `columna > tabla > esquema/base de datos > conexión`, y que la conexión sea el eje
  *más ligero* es la parte contraintuitiva que hace funcionar el caso que motivó
  todo: una regla general sobre una conexión entera debe perder frente a una que
  nombra la tabla y la columna exactas, mientras que entre dos reglas por lo demás
  idénticas debe ganar la fijada — que es justamente para lo que sirve un eje de
  desempate. Así, un esquema por defecto para `configuration` en todas partes más
  una excepción en la tabla cuya forma difiere son dos reglas, no doce. El frontend
  no reimplementa nada de esto: sería una segunda implementación de una sola
  gramática (gotchas #30/#33), y la deriva sería silenciosa, porque un fallo de
  resolución no es un error, es «no ha aparecido el autocompletado», que nadie
  reporta. La resolución es una llamada por pestaña de datos, cacheada por
  relación, así que es la granularidad y no el lenguaje lo que responde a la
  objeción de rendimiento.

- **«Crear a partir de este valor», porque pedirle a alguien que escriba un esquema
  JSON a mano tiene una tasa de adopción cercana a cero.** La insignia redacta uno
  a partir del documento que tienes delante: le pones nombre, revisas el borrador y
  queda creado y vinculado sin salir del editor. Sus reglas están documentadas en
  vez de ser magia, y dos de ellas existen para que no produzca un esquema que
  rechace las filas de las que se redactó: `required` es la *intersección* de las
  claves presentes en todas las muestras, nunca la unión, y un `enum` solo se
  escribe cuando un valor se ha repetido de verdad — tres valores distintos en tres
  filas son un tamaño de muestra, no un dominio cerrado. Siempre declara `$schema`,
  que es funcional y no decorativo: sin él el servicio de lenguaje valida con
  semántica 2020-12 en lugar de draft-07. La salida es estable byte a byte para la
  misma entrada, así que regenerar un esquema produce un diff legible.

- **Tres superficies vinculan una columna, en orden decreciente de uso.** La que
  importa es una **insignia en la cabecera del editor de celda** (tanto en el modal
  como en el panel lateral acoplado), junto a la insignia de JSON válido: nombra el
  esquema resuelto, dice «sin esquema» en bajo contraste cuando no hay ninguno, y su
  desplegable vincula cualquier entrada de la biblioteca, redacta una nueva o
  desvincula. Es la superficie universal: es la única que tienen MongoDB y SQL
  Server. Segunda, una **sección nueva de Ajustes → Esquemas JSON**: la biblioteca a
  la izquierda, el documento de la entrada seleccionada a la derecha en un panel
  Monaco que edita en el sitio y se expande a pantalla completa con F11 en vez de
  apilar un segundo modal, y debajo la tabla completa de vínculos en orden de
  resolución. Tercera, un **campo por columna en el editor de estructura de tabla**,
  deliberadamente acotado — ver *Cambiado*.

- **La tabla de vínculos muestra la cascada en vez de listarla.** Un eje comodín
  dibuja el glifo `*` y nunca una celda vacía, porque una celda vacía se lee como
  «aún sin rellenar», el error de lectura más común en cualquier tabla de
  precedencia. El orden de las filas *es* la precedencia, ya que el backend las
  devuelve ordenadas. Y una caja **«Probar una columna»** responde a la pregunta que
  esta feature va a generar más — *¿por qué no se aplica mi regla?* — a través del
  mismo resolutor que usa el editor, así que la respuesta no puede discrepar de lo
  que ocurre al editar. Un contador de coincidencias en vivo era la alternativa y es
  peor: tendría que recorrer los catálogos de todas las conexiones vivas y aun así
  solo cubriría lo que esté conectado.

- **Export/import de fichero independiente (`meta.kind = "json-schemas"`), más
  inclusión opcional en la exportación de un entorno.** Sin contraseña en ninguno de
  los dos casos: un esquema no contiene secretos ni material del llavero. La regla
  interesante es qué pasa con un vínculo fijado a una *conexión*, dado que el
  identificador de una conexión es un uuid local a la máquina que lo acuñó: al
  importarlo en otra, ese vínculo llega **desactivado**, conservando su ámbito
  original. No se ensancha a «cualquier conexión» (eso cambiaría el significado de la
  regla) ni se descarta en silencio (eso perdería la intención sin que nadie se
  entere), y el asistente de importación dice el número antes de escribir nada. Una
  importación de entorno, en cambio, lo traduce, a través del mismo mapa de
  identificadores original→nuevo que ya usa `launch.visible_connections`.

- **Una guía nueva, `docs/JSON_SCHEMAS.md`** (con su gemela en español), en el
  repositorio y en Ayuda → Documentación. Cubre la vía de 30 segundos, la cascada
  con un ejemplo resuelto de dos reglas, los límites exactos del esquema inferido,
  la advertencia sobre compartir y una sección de «lo que esto no es», que incluye
  los tres comportamientos del servicio de lenguaje lo bastante sorprendentes como
  para convertirse en preguntas de soporte: el `$schema` propio de un documento
  tiene prioridad sobre su vínculo, un solo `$ref` sin resolver impide que se valide
  el documento entero, y nunca se descarga nada de la red.

- **Tres preferencias: validación, autocompletado y ayuda al pasar el ratón.**
  Separadas porque el servicio de lenguaje las separa: un esquema aproximado ya sirve
  para autocompletar mucho antes de que alguien quiera subrayados rojos. Viven en la
  sección de Esquemas JSON y no bajo Editor, la misma decisión que ya toma
  `AppearanceSection` con el grupo de vista de datos. Además, cuatro acciones nuevas
  en la paleta de comandos y tres entradas de salto a preferencia.


- **Los orígenes compartidos pueden ahora publicar y sincronizar de forma
  continua un entorno completo (#108), no solo conexiones sueltas.** Hasta
  ahora `sync_origin` daba por supuesto que el fichero era un paquete de
  perfiles (`meta.kind = "profiles"`); apuntar un origen a una exportación de
  entorno (`meta.kind = "environment"`, el mismo fichero que ya escribe
  `export_environments`) sincronizaba en silencio solo sus `profiles` y
  descartaba todas las entradas de `environments`, ya que `serde_json` ignora
  los campos desconocidos en lugar de fallar. Ahora `sync_origin` lee el tipo
  declarado del propio fichero y, para una exportación de entorno, reconcilia
  un entorno espejo local en cada tirón: lo crea la primera vez y refresca su
  nombre/color/icono/tema y su pertenencia de conexiones
  (`launch.visible_connections`) en cada sincronización posterior. La
  correspondencia entre sincronizaciones se hace por
  `(origin_id, origin_source_id)` — el `Environment.id` del publicador en el
  momento de exportar, un campo nuevo en `ExportedEnvironment` — y no por
  nombre ni por posición en el fichero, que pueden cambiar entre
  sincronizaciones. Un entorno espejo es de solo lectura en el raíl y en el
  selector (solo se renombra, recolorea o borra vía adoptar/retirar,
  exactamente como ya ocurría con un perfil de conexión propiedad de un
  origen) y, si su paquete desaparece en una sincronización posterior, se
  reporta como desaparecido en lugar de borrarse: la misma regla de «reportar,
  nunca destruir por iniciativa propia» que ya seguía el lado de las
  conexiones. Deliberadamente **no** registra automáticamente los orígenes
  anidados dentro del paquete: un fichero compartido nunca debe poder hacer
  que una máquina registre más orígenes por su cuenta, eso queda reservado al
  `import_environment` consciente y puntual.
### Cambiado

- **El editor de celda pasa ahora a Monaco un `path` de modelo estable.** Este era
  el cambio habilitante de todo lo anterior: los esquemas se asocian por `fileMatch`
  contra la URI del modelo, y el `inmemory://model/N` autogenerado que recibe un
  editor pelado no coincide con nada registrable, así que ningún esquema podía
  aplicarse. La ruta lleva qué superficie la posee, porque el modal y el panel
  acoplado pueden estar abiertos a la vez y dos editores que comparten ruta comparten
  modelo: el primero en desmontarse lo destruiría bajo el otro.

- **Los botones de expandir en línea dicen cuándo hay un esquema vinculado**,
  mostrando `{}` en lugar del glifo de expandir y nombrando el esquema en su tooltip.
  El doble clic sigue abriendo el mismo editor en línea de una sola línea (el gotcha
  #12 se mantiene); solo cambian el icono y el tooltip. Un `<input>` de una línea no
  puede ofrecer autocompletado ni validación, así que la única pista útil es que
  merece la pena escalar.

- **Una columna vinculada fuerza el modo JSON del editor**, por encima de la
  heurística de tipo de contenido. Esa heurística solo responde «json» cuando el
  texto parsea, lo que dejaría un documento momentáneamente roto sin ninguna
  validación, precisamente cuando es más útil. Un vínculo es el usuario afirmando que
  la columna contiene JSON.

- **El editor de estructura de tabla gana una afordancia `{}` por columna, acotada
  fuera del DDL.** Un vínculo es metadato local del editor, no un cambio de esquema:
  vive en su propio estado y no en la columna de trabajo, así que no puede colarse en
  el payload de `preview_structure_change` ni volver a disparar la previsualización de
  DDL (gotcha #16). Se guarda en el momento de elegirlo, va detrás de un separador
  discontinuo con la etiqueta `local`, y está desactivado mientras se diseña una tabla
  que aún no existe. Los renombrados de columna se siguen tras un apply correcto, en
  modo best-effort: el DDL ya ha corrido, así que un fallo ahí es un aviso y nunca un
  rollback.

- **`ExportEnvironmentDialog` gana un interruptor opcional «Incluir los esquemas JSON
  y sus vínculos».** Los esquemas son globales, así que esto empaqueta la biblioteca
  completa junto al entorno en lugar de hacerla parte de él: un solo fichero para
  preparar una máquina nueva.

- **Borrar una conexión elimina también los vínculos fijados a ella**, indicando
  cuántos. El identificador de un perfil es un uuid que no se reutiliza jamás, así que
  ese vínculo no puede volver a coincidir: es una regla provablemente muerta y no algo
  inerte pero posiblemente significativo, lo que la convierte en un payload con clave
  que merece ser segado (gotcha #27). La asimetría es lo que lo hace seguro: el
  esquema, el artefacto caro, no se toca nunca.


- **El borrado masivo de conexiones, el borrado de un entorno y la
  eliminación de un origen compartido usan ahora un diálogo de confirmación
  real en lugar del `window.confirm` nativo.** El diálogo para eliminar un
  origen indica además de antemano cuántas conexiones y entornos publicados
  por él quedarán marcados como huérfanos por la corrección de abajo, para que
  «lo que publicó se queda» no sea una advertencia abstracta.

- **Las opciones de importar/exportar del menú Archivo ahora se agrupan bajo
  una cabecera de sección por tipo** (Perfiles / Entornos / Esquemas JSON) en
  lugar de separarse con simples `DropdownMenuSeparator` vacíos. Con seis filas
  «Importar…»/«Exportar…» parecidas seguidas, un separador vacío se leía como
  «límite entre elementos sin relación» y no como «nueva categoría» — reutiliza
  el mismo recurso de cabecera en línea que `ViewMenu` ya aplica a sus grupos
  «Paneles»/«Árbol de esquema». Ahora Importar aparece antes que Exportar en
  las tres secciones (Entornos y Esquemas JSON iban Exportar-luego-Importar;
  solo Perfiles ya seguía ese orden). «Importar entorno…» pasa a llamarse
  «Importar entornos…» (y lo mismo el título del diálogo y del selector de
  fichero), ya que un mismo fichero puede contener más de un entorno, a
  juego con «Exportar entornos…».

- **Rediseño del diálogo de novedades (`WhatsNewDialog`) para que encaje con
  la identidad de marca, y reescritura de su frase principal de la 1.17.0.**
  El diálogo usaba antes un icono `Sparkles` genérico y un párrafo entero
  como frase de cabecera; ahora arranca con el logotipo sobre el fondo de
  tramado (el mismo recurso que usan `AboutSection`, `EmptyState` y la
  pantalla de arranque), de forma que se repinta con el tema activo porque
  cada color es un token semántico. La frase de cabecera es ahora una única
  oración contundente que dice de qué va la versión de un vistazo, en lugar
  de resumir cada novedad. La descripción de cada novedad se recorta a dos
  líneas con un botón «Leer más»/«Leer menos» al estilo WhatsApp
  (`HighlightBody`) — las versiones recientes tienen suficiente matiz como
  para que el texto ocupe 4-5 líneas, y el botón solo aparece cuando el
  párrafo recortado realmente desborda (`scrollHeight` frente a
  `clientHeight`), así que una novedad corta nunca genera un botón que no
  hace nada al pulsarlo.

- **Se ha reconstruido el aspecto del diálogo del editor de celda
  (`CellEditor`) para que encaje con el resto de la app en vez de con un
  resto anterior al rediseño de marca.** Su cabecera era antes una segunda
  tarjeta con su propio borde y sombra flotando dentro del borde del propio
  diálogo — dos contornos anidados que se leían como algo sin sentido, y que
  empujaban el botón de cerrar del diálogo hacia el hueco de bajo contraste
  entre ambos, dejando la `×` casi invisible. La cabecera y el pie son ahora
  a sangre completa con un único `border-b`/`border-t`, el mismo convenio que
  ya usan `SettingsDialog` y el recién rediseñado `WhatsNewDialog`, de forma
  que el botón de cerrar queda directamente sobre la superficie de la
  cabecera con contraste correcto en vez de flotar en una costura.

- **La insignia de esquema JSON en la barra de herramientas del editor de
  celda (`SchemaBindingBadge`, nueva prop `className`) es ahora un botón
  outline propiamente dicho, anclado al borde derecho de la barra**,
  compartiendo `buttonVariants` con el botón «Formatear» vecino en lugar de
  renderizarse como una diminuta píldora en mono/10px que se leía como una
  etiqueta suelta y no como un control. Los estados vinculado/declarado
  mantienen su tinte de marca/aviso, solo que a escala de botón. La píldora
  en línea de `variant="compact"` del editor de estructura (una por fila de
  la tabla) no cambia.

### Corregido

- **Un SELECT escrito a mano sin `LIMIT`/`TOP` sobre una tabla grande podía
  tirar abajo toda la app con un fallo por falta de memoria, y el cronómetro
  del botón «Ejecutar» seguía girando durante todo el tiempo que duraba
  eso.** Reportado contra SQL Server (una consulta pegada directamente desde
  SSMS sobre una tabla de varios millones de filas), pero la causa raíz la
  compartían todos los drivers SQL: `execute_query`/`execute_batch`
  (`src-tauri/src/commands/query.rs`) entregaban el SQL del editor
  directamente a `sqlx::query(..).fetch_all(..)` para Postgres/MySQL/SQLite y
  a `simple_query(..).into_results()` de `tiberius` para SQL Server, y los dos
  almacenan en memoria el conjunto de resultados *entero* antes de devolver
  una sola fila — y `DataGrid` luego renderizaba cada una de esas filas en el
  DOM (ver el arreglo de virtualización más abajo). Tampoco nada de esto tenía
  límite de tiempo: el cronómetro junto a «Ejecutar» es un `setInterval`
  puramente cosmético, no un timeout real, así que nada en la cadena
  cancelaba nunca la llamada al driver — la consulta corría hasta el final (o
  hasta agotar la memoria antes) sin importar cuánto llevara la interfaz
  esperando. Las sentencias `find`/`aggregate` de mongosh tenían la misma
  forma de cursor sin límite.

  Cada vía de lectura ad-hoc (`execute_query`, `execute_batch`, y
  `find`/`aggregate` de MongoDB) conserva ahora como máximo
  `MAX_ADHOC_QUERY_ROWS` (50 000) filas, mediante un nuevo helper genérico
  `fetch_capped` que hace streaming de un SELECT con `fetch()` de sqlx en vez
  de `fetch_all()`, un nuevo `simple_query_sets_capped` en el pool de SQL
  Server que recorre el `QueryStream` de `tiberius` elemento a elemento, y un
  `collect_capped` para los cursores de Mongo. Las filas que sobran del límite
  se siguen drenando (SQL: para que la conexión/sesión del pool quede en un
  punto limpio del protocolo en vez de a mitad de respuesta — cortar el
  stream antes de tiempo corrompería la siguiente consulta de quien reutilice
  esa misma conexión; Mongo: el cursor simplemente se descarta, una operación
  soportada) — se descartan, no se aplazan, así que la memoria del backend se
  mantiene acotada sin importar cuántas filas coincidan de verdad con la
  consulta. `QueryResult.truncated` informa de cuándo ha pasado esto, y la
  cuadrícula muestra ahora una insignia «truncado» en la barra de herramientas
  (con una pista para añadir un `LIMIT`/`TOP`) en vez de devolver en silencio
  un resultado parcial sin ninguna indicación de que se ha recortado algo.
  `fetch_table_data`/`fetch_collection_data` (el navegador paginado de
  tablas/colecciones) no se ven afectados — siempre aplican su propio
  `LIMIT`/`OFFSET` y nunca truncan.

  El renderizado de filas de `DataGrid.tsx` se apoya ahora en
  `@tanstack/react-virtual` en vez de montar incondicionalmente un `<tr>` real
  por fila — el propio comentario de cabecera del fichero afirmaba
  (incorrectamente) que las filas se «virtualizaban gracias al
  `overflow-auto` del contenedor padre», que no es cómo funciona
  `overflow-auto`, y es exactamente lo que dejaba que un resultado ya acotado
  a 50 000 filas siguiera atascando el renderizador incluso después de que el
  backend dejara de quedarse sin memoria.

- **Eliminar un origen compartido podía dejar sus conexiones atascadas para
  siempre** si se pasaba por alto el aviso «quedármela / borrarla» de la app
  antes de cerrarla — el aviso vivía solo en memoria (`useOriginSync.vanished`),
  así que reiniciar la app lo perdía para siempre, y una conexión marcada con
  un `origin_id` colgante es de solo lectura e imborrable en la interfaz, sin
  ninguna otra forma de quitarle la marca. `syncAll()` ejecuta ahora también
  un barrido de reconciliación en cada pasada (arranque, el sondeo cada cuatro
  horas y «Sincronizar ahora») que atrapa cualquier perfil o entorno espejo
  cuyo `origin_id` no coincida con ningún origen actualmente registrado y le
  levanta el mismo aviso de adoptar/retirar, sin necesitar el nombre del
  origen (se muestra como «un origen compartido que ya no existe»). El botón
  «Sincronizar ahora» de Ajustes → Orígenes ya no se deshabilita cuando no hay
  ningún origen registrado, ya que este barrido es útil precisamente en ese
  estado — justo después de eliminar el último.

- **Reimportar perfiles de conexión con «sobrescribir» ya no rompe en silencio nada
  indexado por el identificador del perfil.** `apply_profile_imports` acuña un uuid
  nuevo incluso al sobrescribir un perfil existente, algo de lo que antes no dependía
  nada y que por tanto era invisible. Con los vínculos en juego significa que una
  sobrescritura deja de hacer coincidir en silencio todas las reglas fijadas a ese
  perfil: sin error, el autocompletado simplemente desaparece, y el barrido del
  borrado nunca salta porque no se ha borrado nada. La función devuelve ahora el
  subconjunto de sobrescrituras de su mapa de identificadores, y ambos llamantes lo
  usan para reapuntar los vínculos afectados.

- `EnvironmentImportAnalysis` declaraba un campo `totalProfiles` en `src/types.ts`
  mientras que `transfer.rs` envía `total_profiles`. Nadie lo leía, así que nada
  estaba roto, pero la siguiente persona que lo leyera habría obtenido `undefined`.

- **El asistente de importación de entornos reventaba a ventana en blanco en su
  último paso, con «Cannot read properties of undefined (reading 'length')» en la
  consola.** Es el mismo desajuste snake_case/camelCase de un nivel más arriba,
  solo que esta vez algo sí leía el campo: `EnvironmentImportAnalysisEntry.
  connection_count` e `ImportedEnvironment.environment_id`/`origin_ids` no llevaban
  `#[serde(rename_all = "camelCase")]`, así que cruzaban el cable tal cual mientras
  `src/types.ts` e `ImportEnvironmentDialog.tsx` estaban escritos esperando
  `connectionCount`/`environmentId`/`originIds`. El paso de revisión mostraba en
  silencio «undefined conexión(es)»; el paso final, `env.originIds.length`, lanzaba
  directamente, tumbando todo el árbol de diálogos (React no tiene un límite de
  error por encima de `FileMenu`). Reproducido importando un lote de varios
  entornos y eligiendo «Omitir» para cada perfil en conflicto. Ambos structs llevan
  ahora `rename_all = "camelCase"` — los campos `EnvironmentImportResult.
  json_schemas` / `EnvironmentImportAnalysis.total_profiles` un nivel por encima se
  quedan deliberadamente en snake_case (ver los comentarios del código), así que
  esto no es un cambio de nomenclatura general.

- **Eliminar un origen compartido ya no deja huérfano para siempre lo que
  publicó.** `remove_origin` siempre dejaba en su sitio las conexiones (y ahora
  los entornos) que había importado, etiquetadas con un `origin_id` ya
  colgante — deliberadamente, para que un cambio de configuración nunca borre
  en silencio un lote de servidores contra los que alguien tiene trabajo
  abierto. Pero el único mecanismo que llega a ofrecer liberar una de esas
  entradas (el aviso de desaparición de `useOriginSync` → adoptar/retirar) se
  alimentaba exclusivamente de `syncAll()`, que itera los orígenes
  *actualmente registrados*, y un origen eliminado ya no está en esa lista
  antes de poder volver a reportar nada como desaparecido. La conexión (o el
  entorno) se quedaba permanentemente en solo lectura y permanentemente
  imposible de borrar desde la interfaz, sin salida. Eliminar un origen levanta
  ahora ese mismo aviso de inmediato, a partir del estado local y mientras
  todavía se conoce el nombre del origen, reutilizando el flujo existente de
  decidir-después en lugar de inventar un segundo.

- **Importar un lote con muchos perfiles de conexión cifrados ya no bloquea la
  ventana (Windows la marca «No responde») durante toda la importación.**
  `import_environment` e `import_profiles` estaban declarados como comandos
  Tauri síncronos normales, y Tauri los ejecuta directamente en el hilo
  principal de la app en lugar de en el pool de hilos del runtime asíncrono.
  Ambos llaman a `apply_profile_imports`, que ejecuta `transfer::decrypt_secret`
  una vez por cada secreto cifrado: una derivación de clave PBKDF2-HMAC-SHA256
  de 600.000 iteraciones, deliberadamente lenta, con una sal aleatoria propia
  por secreto, así que no hay ninguna derivación compartida que se pueda
  cachear entre ellos. Importar un único perfil nunca sacó esto a la luz;
  importar 13 entornos que compartían un mismo grupo de perfiles de conexión
  (22 de ellos en conflicto con perfiles ya existentes) suponía docenas de
  derivaciones corriendo en serie, cada una costando del orden de cien
  milisegundos o más, bloqueando el hilo principal el tiempo suficiente para
  que Windows reportara la app como colgada. Ambos comandos son ahora
  `async fn`, con la lectura del fichero, el bucle de fusión/descifrado de
  perfiles, el reapuntado de vínculos de JSON Schema y la escritura del
  tab-state movidos a un cierre de `tauri::async_runtime::spawn_blocking`: se
  paga el mismo coste de CPU, pero fuera del hilo que bombea los mensajes de
  la ventana.

- **El editor de estructura podía rechazar su propia vista previa de DDL por
  una columna que nadie había tocado, específicamente en columnas `BIT` de
  MySQL.** MySQL informa del valor por defecto de una columna `BIT` desde
  `information_schema` en su forma literal nativa `b'0'`/`b'1'`, y el editor
  de estructura la copia tal cual en el campo «Por defecto». `validate_structure`
  validaba el valor por defecto de cada columna contra una lista blanca
  conservadora (números, cadenas entre comillas, un puñado de palabras clave)
  sin importar si el usuario lo había tocado, así que con solo abrir una tabla
  con una columna `BIT` y editar una columna sin relación, la previsualización
  o el apply entero fallaban con «unsupported default expression: "b'0'"» —
  un comentario ya había señalado esta misma clase de problema para los
  valores por defecto de Postgres con `cast` (`'foo'::text`) en la ruta de
  volcado/reconstrucción de SQLite, pero la propia ruta `ALTER` del editor de
  estructura nunca recibió el mismo tratamiento. El valor por defecto de una
  columna ahora solo pasa por la lista blanca cuando de verdad difiere de lo
  que hay en el catálogo en vivo; uno sin cambios — en la forma nativa del
  dialecto que informe el servidor — se acepta tal cual.

## [1.16.2] — 2026-08-19

### Añadido

- **Tres nuevas guías de usuario, en la app y en el repo: Conexiones, MongoDB
  y SQL Server.** Ayuda → Documentación tenía exactamente dos entradas
  (Entornos y el conector MCP), así que la mayor parte de lo que hace la app
  solo estaba documentado en la lista de características del README o no
  estaba documentado en absoluto. Las nuevas cubren, respectivamente: crear
  una conexión por cada driver y qué necesita cada uno, por qué SSL es
  explícito en ambas direcciones, túneles SSH (autenticación, el fallback de
  puerto local, la política de host-key y los dos casos que no se pueden
  tunelizar), qué hace realmente "dejar la base de datos en blanco" en cada
  motor, dónde viven las contraseñas y qué nunca toca disco, las preferencias
  de límite de conexiones y su override por servidor, el keepalive y la
  affordance de reconexión, cada flag de la CLI incluida la forma ad-hoc
  efímera por construcción, exportación/importación cifrada con la salvedad
  de la URI de MongoDB, y los orígenes compartidos con su modelo de amenaza
  real — el dialecto `mongosh` que acepta el editor de consultas y lo que
  rechaza deliberadamente, las reglas de direccionamiento por ruta y
  fidelidad de tipos del editor de documentos, los pipelines de agregación y
  las vistas (incluido por qué se rechazan `$out`/`$merge`), el gestor de
  índices y por qué MongoDB es el único driver que lo tiene, renombrar/mover
  una colección, y una tabla de lo que no está implementado con el motivo —
  y el manejo de `HOST\INSTANCIA` con el SQL Browser, la confianza de
  certificados, la autenticación de Windows, cómo se renderiza cada tipo de
  valor (`decimal` exacto, `money` a través de un double, `bit` como 0/1,
  binario como hex), los detalles de escritura visibles en la Consola, y las
  cuatro superficies aún deshabilitadas.
- **`docs/README.md` como índice de la carpeta docs** (con su gemelo en
  español), separando las guías de usuario de las notas de diseño internas y
  documentando los cuatro pasos para añadir una guía — el fichero, la entrada
  en `docs.ts`, las claves i18n y la ruta `DOC_FILES` de `vite.config.ts` que
  inyecta su fecha de última actualización — además de las restricciones del
  renderizador de markdown integrado en la app. La sección Docs del README
  raíz ahora enlaza a ese índice y a cada guía; antes no mencionaba
  `ENVIRONMENTS.md` en absoluto.
- Las entradas del visor integrado se ordenan por orden de lectura en lugar
  de alfabéticamente (Conexiones → Entornos → MongoDB → SQL Server → MCP),
  ya que el diálogo se abre en la primera.

- **La vista de lista ya puede insertar una fila / documento.** «Insertar»
  quedaba oculto siempre que la rejilla estaba en modo lista, lo que dejaba
  ese modo casi de solo lectura: se podía editar cualquier campo de un
  documento existente y borrarlo, pero añadir uno obligaba a volver a la
  vista de tabla. El borrador se dibuja como una tarjeta fijada encima de los
  documentos — una línea `clave : control` por campo, con exactamente los
  mismos controles que usa la fila borrador de la tabla (marcador de PK
  autogenerada, combo de FK, selector 0/1 para BIT, input plano), ahora
  extraídos a un `DraftCellControl` compartido para que las dos superficies no
  puedan divergir en los detalles que importan (una columna BIT tiene que
  emitir la cadena numérica que espera el `CAST` del backend, gotcha #15). Se
  confirma con la misma llamada `insert_row`: cambiar de modo de vista cambia
  cómo se *dibuja* el borrador, nunca lo que escribe. Dos diferencias
  deliberadas respecto a la fila de la tabla: que el foco salga de la tarjeta
  **no** la confirma (una tarjeta es un formulario, y aloja un selector de
  tipo cuyo popover vive fuera de ella — confirmar al perder el foco
  dispararía el INSERT en el instante en que se abriera ese selector), así que
  Enter o «Guardar» confirma y Esc o «✕» descarta; y en MongoDB cada campo
  lleva su propio **selector de tipo BSON**, enviado como pista de tipo de
  `insert_row`. Esto último es la razón de hacerlo aquí en vez de reutilizar
  la fila de tipos fijos de la tabla: una colección no tiene esquema, así que
  el tipo con el que se guarda un campo nuevo es una *decisión*, e inferirlo
  del texto escribiría un `Int32` en un campo que la colección guarda como
  `Long` — la trampa de fidelidad que el gotcha #29 documenta para las
  ediciones, un paso antes. El conjunto de campos sigue siendo la lista de
  columnas del resultado (en MongoDB, las claves de primer nivel de la página
  actual); los campos extra se añaden al documento nuevo con el `+` por
  documento una vez que existe.

### Corregido

- **A `docs/MCP.es.md` le faltaba toda la sección "Huella de conexiones"**,
  incluyendo "Compartir los pools de la app", y su introducción seguía
  diciendo que el conector _no puede_ compartir los pools de la app de
  escritorio — lo cual dejó de ser cierto cuando llegó la preferencia
  `Share pools with the MCP connector`. Ambas ya están sincronizadas con el
  original en inglés.

- **SQL Server: los valores `decimal`/`numeric` negativos se renderizaban
  como una cadena malformada** (`-18.900000000` volvía como
  `-18.-900000000`). El `Display for Numeric` de `tiberius` formatea la
  parte entera y la fraccionaria por separado —
  `write!(f, "{}.{:0pad$}", n.int_part(), n.dec_part())` — y ambas se derivan
  de la misma mantisa `i128` con signo, así que un valor negativo emite su
  signo dos veces _y_ pierde el relleno de ceros de la parte fraccionaria en
  el mismo aliento: `-18.09` salía como `-18.-9`, `-0.000000001` como
  `0.-00000001`, y un valor menor que 1 perdía el signo por completo
  (`-0.5` → `0.-5`, porque `int_part()` de ese valor es `0`). Un
  `decimal(18,0)` también crecía una cola `.0` espuria. `mssql_value` ahora
  formatea estas columnas él mismo a partir de la mantisa y la escala en
  crudo (`numeric_to_string`) en lugar de llamar a `to_string()`: el signo se
  quita una sola vez, la magnitud se rellena con ceros hasta al menos
  `scale + 1` dígitos, se separan `scale` dígitos por la derecha — sin ningún
  paso por `f64`, que es precisamente la razón por la que estas columnas
  viajan como texto. Afectaba por igual a todo consumidor de un decimal
  negativo: la rejilla de datos, la copia/exportación a CSV/JSON, y el
  conector `huginndb-mcp`, donde se reportó. `first_i64` (la ruta de
  `COUNT(*)`/estimación de filas) también dejó de perder el round-trip por la
  misma cadena rota — lee `int_part()` directamente, ya que la forma
  renderizada de cualquier escala distinta de cero no es algo que
  `parse::<i64>` acepte.

- **La fila pendiente de insertar aparecía y desaparecía al instante cuando se
  iniciaba desde un menú.** Reportado como «la fila borrador parpadea y
  desaparece»; el botón «Insertar» de la barra de herramientas funcionaba, las
  dos entradas de menú (el menú contextual de la fila y el menú de desborde de
  la barra, donde el botón se mueve cuando el panel es estrecho) no. Ambas son
  menús de Radix, y el `FocusScope` de Radix restaura el foco al elemento que
  lo tenía antes de abrirse el menú desde su propio `setTimeout(…, 0)` al
  desmontarse. La rejilla enfocaba la primera celda del borrador en un
  `requestAnimationFrame`, que se ejecutaba *antes* de ese timeout — así que
  Radix se llevaba el foco de vuelta fuera de la fila recién montada, se
  disparaba el manejador de salida de foco de la fila, y un borrador en el que
  nadie ha escrito se cancela en silencio (a propósito: de lo contrario
  enviaría un `INSERT () VALUES ()`). El foco se concede ahora en un
  `setTimeout` encadenado *después* del frame, que siempre queda encolado
  detrás del de Radix, así que el borrador conserva el foco sea cual sea el
  orden en que se intercalen las dos callbacks. El frame sigue siendo lo que
  espera a que la fila esté montada.

- **Enter o Escape dentro de un selector de valores de FK confirmaba o
  descartaba el borrador entero.** El borrador vincula Enter a «inserta esta
  fila» y Escape a «descártala» a nivel de fila, y `FkCombobox` llamaba a
  `preventDefault` en las teclas que maneja pero nunca a `stopPropagation` —
  así que abrir el selector con Enter disparaba el INSERT con una fila a
  medias, y cerrarlo con Escape tiraba el borrador. Ambos manejadores (el
  disparador y el campo de búsqueda del panel) detienen ya el evento en el
  combo, el único componente que lo ha consumido.

- **El estado vacío de la vista de lista era la única pantalla vacía sin
  identidad visual.** Una colección o tabla sin filas renderizaba una línea
  gris «Sin filas» a secas, mientras que la vista de tabla muestra el marco
  compartido `EmptyState` — trama de semitonos, medallón, la marca con su
  glifo por estado — desde el rediseño de marca. La vista de lista usa ya ese
  mismo marco (y también la previsualización de una agregación cuyo pipeline
  no devolvió nada), suprimido mientras hay una tarjeta de inserción abierta:
  la superficie ya no está vacía, es un formulario.

### Cambiado

- **`docs/MCP.md` (+ el gemelo en español) ahora documenta las dos barreras
  de aprobación independientes por las que pasa una escritura**, tras el
  reporte de una conexión con política `full` cuyo cambio de esquema seguía
  rechazándose — por el cliente de IA, no por el conector. Nueva subsección
  "Cuando el cliente bloquea la llamada, no el conector": una tabla para
  distinguir un rechazo del conector (un resultado de tool que nombra la
  política, más una línea en `mcp-audit.log`) de un bloqueo del lado del
  cliente (la llamada nunca llega al conector, así que el audit log queda en
  silencio), por qué el clasificador de modo automático de Claude Code trata
  el DDL contra un servidor real como una migración contra infraestructura no
  reconocida por defecto, y los cuatro remedios del lado del cliente — un
  reintento puntual desde `/permissions`, una petición explícita (la
  intención explícita despeja los bloqueos suaves del clasificador), una
  regla `permissions.allow` para el tool, o entradas
  `autoMode.environment`/`autoMode.allow` que describan la instancia. Todos
  ellos dependen de quien ejecute el cliente; documentarlos no relaja el
  conector, cuya propia política sigue aplicándose después de que el cliente
  apruebe la llamada.

- **`docs/MCP_CONNECTOR_ROADMAP.md`: una sección abierta sobre distribuir el
  conector a través de un marketplace en vez de una instalación por
  máquina.** Registra las tres rutas candidatas y sus veredictos — el
  directorio de conectores de claude.ai no es viable (lista servidores
  _remotos_, y este lee `profiles.json`, el keychain del sistema y la propia
  red del usuario), mientras que el marketplace de plugins de Claude Code y
  una extensión `.mcpb` de Claude Desktop sí lo son — más la restricción que
  comparten (ninguno puede empaquetar un sidecar compilado por destino, así
  que ambos necesitan un lanzador que resuelva el ya instalado) y los dos
  prerrequisitos que merece la pena hacer en cualquier caso: sacar la lista
  de perfiles expuestos de `--connections` hacia el propio estado de
  HuginnDB, y declarar `_meta["anthropic/requiresUserInteraction"]` en los
  tools de escritura. También deja claro por qué "el marketplace gobierna
  mejor los permisos" se reduce a una cuestión de distribución: la
  aprobación ya pertenece por completo al cliente, y la política de
  escritura es un segundo techo, del lado del servidor, aplicado después de
  ella.

## [1.16.1] — 2026-08-18

### Añadido

- **Exportar/importar uno o varios entornos como paquete autocontenido.**
  File → "Exportar entornos…" abre una checklist (por defecto todo
  seleccionado) que escribe un único JSON con, por cada entorno elegido, su
  nombre/color/tema, sus orígenes compartidos registrados (solo nombre y
  ruta — nunca la contraseña de cifrado, siguiendo el mismo modelo de
  amenaza que ya tenía `origins.rs` de mantener el secreto fuera de banda),
  y un único conjunto deduplicado de los perfiles de conexión que
  referencian entre todos (una conexión compartida por dos entornos
  seleccionados se escribe una sola vez, no se duplica). El mismo diálogo
  también se abre preseleccionando una sola fila desde un atajo en
  `EnvironmentSwitcher`. File → "Importar entorno…" lee uno de estos
  ficheros y **siempre crea entornos nuevos** — uno por cada paquete del
  fichero, nunca fusionados ni sobrescritos sobre uno ya existente, así que
  los entornos exportados por un compañero nunca pueden colisionar con tus
  propios orígenes, conexiones o lista de entornos. Quedan deliberadamente
  fuera: pestañas, geometría del dockview y el estado de lanzamiento, que
  son artefactos de sesión ligados a la máquina que los produjo (ver gotcha
  #10) y no parte de la identidad portable de un entorno. El árbol de
  conexiones de cada entorno nuevo queda acotado exactamente a sus propios
  perfiles importados mediante el filtro `visible_connections` ya existente
  (#107), y ninguno se conecta automáticamente. Los conflictos de perfiles
  de conexión se resuelven una sola vez para todo el fichero, reutilizando
  la misma UI de resolución de `import_profiles`
  (sobreescribir/omitir/renombrar); un origen importado cifrado muestra el
  mismo estado de "sin contraseña guardada" que uno recién añadido, resuelto
  en la siguiente sincronización.
- **Objetivo de paquete `.rpm`**, junto a los ya existentes `.deb`/`.AppImage`,
  para distribuciones de la familia Fedora/openSUSE/RHEL. El empaquetador rpm
  de Tauri (el crate `rpm`) es Rust puro — sin `rpmbuild` ni paquetes de
  sistema adicionales — así que se construye desde la misma tanda de release
  en `ubuntu-22.04` sin cambios en CI más allá de la lista de objetivos en
  `tauri.conf.json`. Se añadió también `bundle.license: "MIT"`, ya que una
  cabecera de licencia vacía en un paquete RPM se muestra como "Unspecified".
  Probado mediante `workflow_dispatch` con la etiqueta desechable
  `v0.0.0-test` (ejecución #62): ambas tandas se completaron y el release en
  borrador incluyó un `HuginnDB-1.16.0-1.x86_64.rpm` válido junto al resto de
  artefactos. Eso confirma que la salida del empaquetador está bien formada —
  la instalación/arranque real en una máquina Fedora/openSUSE sigue sin
  verificar (ver el punto 7 de `ROADMAP.md`).
- **Renombrar una colección de MongoDB**, moviéndola opcionalmente a otra
  base de datos en la misma operación. `renameCollection` es un run-command
  sobre la base `admin` que cualifica ambos lados con el nombre de la base,
  así que el movimiento sale gratis con el renombrado: no hay una operación
  "mover" aparte que construir. La entrada aparece en el menú contextual de
  la colección junto a Vaciar/Eliminar, y el diálogo de renombrado incorpora
  un selector de base de destino (solo MongoDB) con un aviso de que un
  movimiento entre bases copia los documentos en el servidor y requiere
  permisos en ambas. `dropTarget` es siempre `false`: renombrar sobre una
  colección existente es un error que el usuario ve, nunca un borrado
  silencioso de lo que hubiera allí. Las vistas se rechazan de antemano con
  un mensaje que dice qué hacer en su lugar — MongoDB no sabe renombrar una
  vista, solo eliminar y recrear, que es también la razón por la que el
  editor de vistas nunca lo ofreció. El renombrado pasa a depender de su
  propia capacidad `supportsRenameTable` en vez de `supportsDdlEditing`: no
  necesita un constructor de DDL, que es justo por lo que MongoDB puede
  tenerlo mientras la edición de estructura sigue siendo de solo lectura ahí.
- **Atajo propio para "Recargar esquema"** (`Ctrl+Shift+R` por defecto),
  reasignable junto a los demás en Ajustes → Atajos. `F5` sigue recargando
  las filas de la rejilla activa; este relee el catálogo.

### Corregido

- **"Actualizar" ahora recarga la base de datos que estás mirando de
  verdad.** En una conexión multi-BD las tablas viven en los slices hijos
  sintéticos `<padre>::db::<bd>`, pero el menú del nodo de base de datos, el
  de la fila de conexión y la paleta de comandos refrescaban el id _padre_:
  volvían a pedir una lista de tablas que nadie pinta (en MySQL el pool padre
  no tiene base seleccionada, así que legítimamente viene vacía) y dejaban
  intacto el subárbol visible. Una tabla creada fuera de la app no aparecía
  por muchas veces que se pulsara Actualizar. El nuevo
  `useSchema.refreshTree` refresca una conexión junto con todas las vistas
  por base abiertas debajo, y el nodo de base de datos refresca su propio
  hijo explícitamente.
- **Actualizar ahora invalida las columnas e índices cacheados.** Solo volvía
  a pedir las listas de bases y de tablas, arrastrando el resto del slice sin
  tocarlo — y como el explorador carga las columnas de una tabla solo cuando
  _faltan_ (para que plegar y desplegar no vuelva a consultar), una columna
  añadida fuera de la app seguía invisible hasta desconectar. Las tablas
  desplegadas se recargan justo después del vaciado, así que un nodo abierto
  vuelve con sus columnas actuales.
- **SQL Server: se acepta `SERVIDOR\INSTANCIA`, en cualquiera de los dos
  campos.** SSMS tiene una única caja "Nombre del servidor" y separa esa
  forma él mismo; HuginnDB no separaba nada, así que pegarla en el campo de
  instancia producía una consulta al SQL Browser que jamás podía casar (el
  Browser solo publica el nombre corto de la instancia) y pegarla en el campo
  de host fallaba en la resolución DNS con un error que no mencionaba
  instancias. Ahora ambos campos se normalizan con `split_instance`, en el
  backend (autoritativo — cubre también la CLI y el conector MCP) y en el
  diálogo de conexión al salir del campo, para que el usuario vea la
  separación en vez de que ocurra en silencio.
- **SQL Server: un SQL Browser parado o bloqueado por firewall ya no impide
  conectar a una instancia nombrada con puerto estático.** UDP 1434 es un
  servicio distinto del puerto TCP de la propia instancia; si el Browser no
  responde, ahora se prueba el puerto indicado en el diálogo antes de
  rendirse, y el fallo informa de ambas causas en lugar de solo la última. Un
  puerto dejado en el 1433 por defecto no se interpreta como puerto estático.
- **SQL Server: el rechazo de "una instancia nombrada no se puede tunelizar"
  se evalúa antes de abrir el túnel SSH**, en vez de después de pagar el
  handshake.

- **Al hacer clic en una fila de tabla del árbol de esquema en casi
  cualquier punto salvo su nombre se expandía la vista previa de columnas
  en lugar de abrir la tabla.** `TableRow` envolvía toda la fila — chevron,
  icono, nombre, punto de "abrir en pestaña" y badge de métrica — en un
  único botón que alternaba la lista de columnas, dejando solo el `<span>`
  del nombre aislado mediante `stopPropagation` para abrir una pestaña en su
  lugar. Todo IDE del que este proyecto toma referencia vincula un clic
  simple en la fila a abrirla, así que apuntar a la fila y caer un píxel
  fuera de ese estrecho `<span>` del nombre seguía sorprendiendo a los
  usuarios con un expandir/colapsar no deseado. La fila ahora renderiza dos
  botones hermanos: uno dedicado solo al chevron que alterna las columnas
  (con etiquetas aria `schema.expandColumns`/`schema.collapseColumns`,
  en/es), y un segundo botón que cubre todo lo demás y abre la pestaña de
  la tabla.

## [1.16.0] — 2026-08-17

### Añadido

- **Los índices de MongoDB ya se pueden inspeccionar y editar, desde un gestor
  de índices dedicado.** Eran visibles pero intocables: la pestaña de
  estructura los listaba en solo lectura, `apply_structure_change` rechaza
  MongoDB, y el analizador de sentencias del editor de consultas nunca ha
  conocido `createIndex`. Gestionar un índice significaba salir de HuginnDB
  hacia `mongosh`. **Índices…** en cualquier colección abre ahora una pestaña
  con el catálogo real, con crear, ocultar, reemplazar y eliminar.
  - **La lista es una herramienta, no un catálogo.** Junto a las claves y sus
    propiedades muestra el **tamaño** de cada índice y cuántas operaciones ha
    servido desde el último reinicio del contador. Un índice con meses de
    actividad y cero usos es uno que nadie consulta y que cada escritura paga
    por mantener — lo más útil que puede decir esta vista, y la razón de que
    no sea solo una lista de nombres. Ambas columnas vienen de
    `$collStats`/`$indexStats`, que necesitan sus propios privilegios, así que
    se omiten en vez de mostrarse como ceros cuando el rol de la conexión no
    puede leerlas.
  - **Ocultar está junto a eliminar, a propósito.** Un índice oculto es
    ignorado por el planificador de consultas mientras el servidor lo sigue
    manteniendo al día, así que el efecto de quitar uno se puede medir y
    deshacer al instante. Eliminar un índice grande y arrepentirse cuesta una
    reconstrucción completa.
  - Crear cubre las claves (dirección o tipo por clave, mediante un selector,
    con un modo de texto crudo para lo exótico), `unique`, `sparse`, `hidden`,
    TTL, expresiones de filtro parcial, collations, pesos de texto y una vía
    de escape para fusionar cualquier opción que el formulario no tenga como
    campo. **Editar es un eliminar más un crear** — MongoDB no puede alterar
    un índice en su sitio — algo que el diálogo indica y una confirmación
    repite antes de ejecutarlo.
  - **Nada de lo que informa el servidor se descarta en silencio.** El
    catálogo se lee de los documentos crudos de `listIndexes` en vez de a
    través del `IndexModel` tipado del driver, que solo conserva nombres,
    nombres de campo y `unique`; toda opción más allá de esas — incluidas las
    que añada un futuro servidor — sobrevive hasta el editor y de vuelta.
    Reutilizar esa forma tipada habría reconstruido `{ createdAt: -1 }` en
    ascendente la primera vez que alguien corrigiera una errata en él.
  - `_id_` se rechaza para eliminar, ocultar y reemplazar por el backend, no
    solo se deshabilita visualmente.

- **Las vistas de MongoDB ya se pueden editar, con un editor de agregaciones al
  estilo Compass.** Hasta ahora una vista de MongoDB se podía consultar pero no
  modificar: `commands/view.rs` rechaza MongoDB a propósito, porque una "vista"
  de Mongo no tiene un cuerpo `CREATE VIEW` que comparar — es un pipeline de
  agregación guardado sobre una colección de origen (`{create|collMod, viewOn,
pipeline}`). El nuevo editor de agregaciones es la superficie paralela, y se
  abre de dos formas: **Nueva agregación…** sobre cualquier colección (un
  pipeline de trabajo, que "Guardar como vista" convierte en una vista real) y
  **Editar pipeline…** sobre cualquier vista (con su pipeline cargado; al
  guardar se ejecuta `collMod`). Eliminar una vista de Mongo también funciona
  ya: `drop_view` tiene ahora una rama Mongo, porque esa operación concreta no
  necesita DDL.
  - **Dos modos sobre un mismo pipeline.** _Etapas_ da a cada etapa su propia
    tarjeta con su propia salida —el pipeline truncado tras esa etapa—, que es
    lo que hace legible una cadena de dieciséis `$lookup` en lugar de un único
    resultado opaco. _Texto_ es el array completo en un solo editor con la
    salida del pipeline al lado. Cambiar de modo es una conversión que pasa por
    el backend (`format_mongo_pipeline`), porque partir un array literal en
    etapas requiere la gramática y el cuerpo de una etapa está lleno de comas.
  - **La barra de etapas es un diagnóstico, no una miga de pan.** Cada etapa es
    un chip, en orden, con el número de documentos que emitió en la muestra
    (`10+` cuando la muestra llegó a su límite). Leída de izquierda a derecha
    muestra dónde muere el pipeline: el `$match` que vacía todo lo que viene
    después se marca en `warning` al llegar a cero, y una etapa con error en
    `destructive`.
  - Las etapas se pueden desactivar sin borrarlas (permanecen en el documento y
    quedan fuera de toda petición, y nunca se escriben en una vista guardada),
    reordenar arrastrando, plegar y cambiar de operador desde el selector —que
    sustituye el cuerpo solo si sigue siendo la plantilla sin tocar, y en caso
    contrario reescribe únicamente la clave del operador, de modo que un clic
    equivocado cuesta un deshacer.
  - **Exportar pipeline** copia las etapas activas como llamada `mongosh`, como
    pipeline a secas o como fragmento `db.createView(…)` —esto último es en lo
    que se convierte un pipeline cuando deja de ser una exploración.
  - Los pipelines se escriben en la misma gramática relajada que ya entiende el
    editor de consultas (claves sin comillas, comillas simples,
    `ObjectId(…)`/`ISODate(…)` y ahora comentarios `//` y `/* */`), analizada
    por ese único parser en Rust: el frontend nunca analiza un pipeline. Al
    releer una vista, su BSON guardado se renderiza como ese mismo código
    fuente (`bson_to_shell_text`), así que un `ObjectId` dentro de un `$match`
    sigue siendo un `ObjectId` y un `NumberLong` sigue siendo un `NumberLong`
    tras abrir y guardar, en vez de degradarse a una cadena o a un `Int32` que
    deja de coincidir en silencio.
  - `$out` y `$merge` se rechazan antes de llegar al servidor: el editor
    previsualiza con debounce mientras escribes, y una "vista previa" que
    sobrescribe una colección a media edición no lo es. Toda vista previa está
    acotada por un `$limit` (10 documentos por defecto, ampliable hasta 50).
  - Un nuevo lenguaje de Monaco colorea por separado las dos cosas que
    significan algo en un pipeline —una clave de operador (`$match`, `$sum`) se
    lee como palabra clave y una referencia a campo (`"$customerId"`, `"$$NOW"`)
    como nombre predefinido—, con autocompletado de etapas, operadores de
    expresión y constructores BSON. Usa los nombres de token que ya estilan
    todos los temas, así que los temas personalizados colorean pipelines sin
    saber que existe.

### Cambiado

- **Todos los temas integrados forman ahora pareja claro/oscuro, y el
  catálogo se recortó y reequilibró en consecuencia.** Se eliminan `Dim` y
  `Solarized Dark` — ambos eran presets de un solo modo de los que no se
  podía salir con el toggle sin acabar en un tema por defecto de HuginnDB
  (ver la entrada de Corregido más abajo), y ninguno tenía identidad
  suficiente para justificar construirle una contraparte. Se añaden `Summer
Dark` (una paleta "playa de noche" que conserva el coral/turquesa de Summer,
  aclarado para una superficie oscura, igual que Claude Dark aclara la
  terracota de Claude Light), `Neon Light` (la contraparte "laboratorio sobre
  papel" de la paleta casi negra de Neon — cada tono saturado se oscurece para
  seguir siendo legible sobre una superficie clara, pero el verde
  primary/brand, el cian de `fk`, el amarillo de `pk`/`numeric` y el rosa
  fuerte de `destructive` mantienen la familia reconocible) y `High Contrast
Light` (el mismo lenguaje de contraste máximo invertido a blanco/negro,
  conservando el mismo amarillo de señal para primary/brand/ring). En total,
  diez temas integrados: HuginnDB, Claude, Summer, Neon y High Contrast, cada
  uno con su pareja claro/oscuro.
  - El editor de 26 colores de Preferencias → Apariencia era una única
    rejilla plana de 2 columnas en orden de declaración — tokens sin relación
    (por ejemplo, `border` junto a `input`, tres filas después de
    `brandHover`) uno al lado del otro sin ninguna agrupación visual. Ahora se
    divide en cuatro secciones etiquetadas — Superficies, Acciones y marca,
    Colores de estado, Bordes y foco — mediante un nuevo export
    `COLOR_GROUPS` en `lib/themes.ts`, de forma que un par
    background/foreground y sus vecinos se leen juntos en vez de tener que
    buscarlos con scroll.
- **Toda la interfaz sigue ahora el lenguaje visual de marca de HuginnDB.** El
  universo del logo —contornos negros suaves, esquinas redondeadas, volumen
  ligero, un único azul eléctrico— se aplica como una capa _contenida_ sobre la
  herramienta keyboard-first existente: las superficies de trabajo (grid, SQL,
  JSON) se mantienen tranquilas y la personalidad aparece en las affordances,
  los estados y las pantallas vacías.
  - Los dos temas por defecto se han repintado con la paleta de marca: una
    rampa slate/navy de cuatro niveles de profundidad (`#020617` → `#0b1220` →
    `#111827` → `#1e293b`) bajo un único acento `#2563eb` en oscuro, y blanco →
    `#f8fafc` → `#eef5ff` sobre bordes `#d6e4f5` en claro. El resto de presets
    (Dim, Solarized, Claude, Neon, Summer, High Contrast) no se tocan.
  - Nuevo token de tema `brand-hover`: el acento bajo el puntero es ahora un
    color real por tema (más claro en temas oscuros, más profundo en los
    claros) en lugar de `brand/90`, que fundía el acento con la superficie
    justo cuando debía iluminarse. Es editable como cualquier otro color en
    Preferencias → Apariencia.
  - Botones: esquinas de 12px, borde de 2px en las variantes rellenas y un
    hover que sube 1px hacia un breve resplandor de marca. Inputs, textareas y
    selects comparten un único tratamiento de foco limpio: el borde se vuelve
    azul de marca con un halo suave de 3px, en lugar del anillo despegado.
  - Menús, popovers, tooltips, selects y diálogos se abren con el mismo
    fundido + escala 98→100% dentro de la banda de movimiento de 150–220ms, y
    se apoyan en la rampa de elevación compartida en vez de sombras ad-hoc.
  - Los destinos de arrastre de paneles, el sash activo y un switch activado
    son azules (son affordances); los bordes de los toasts se codifican por
    color según el resultado con un grosor común, con success por fin verde y
    warning sensible al tema en lugar de un ámbar fijo.
  - La barra de actividad y el rail de entornos marcan la entrada activa con
    una barra redondeada de 4px a ras del borde del rail (azul de marca en la
    barra de actividad, el color propio del entorno en el rail) y tiñen de azul
    el icono seleccionado. Ambos railes y los botones del pie del chrome ganan
    anillos de foco por teclado.
  - La conexión seleccionada en el árbol lleva el mismo rail azul que ya tenía
    la tabla activa, más un borde azul de un píxel; las tarjetas de conexión
    del lanzador suben 1px al pasar el ratón y la activa queda dentro de un
    resplandor azul sutil.
  - Data grid: las cabeceras van en semibold sobre una superficie ligeramente
    elevada, y todos los separadores de celda salen ahora del token `border` en
    lugar de un alpha plano del foreground — una línea más suave y sensible al
    tema. El redimensionado de columnas (tirador, hover, columna en curso) es
    azul como el resto de affordances.
  - **Nuevos temas de editor "HuginnDB Dark" / "HuginnDB Light"**
    (Preferencias → Editor), pintados con la paleta de la app: el fondo del
    editor coincide exactamente con el del panel, la línea activa es un realce
    azul suave con el borde por defecto de Monaco suprimido, las palabras clave
    toman el azul de marca y los números el mismo ámbar que usa el grid para
    celdas numéricas. `huginn-dark` es el nuevo valor por defecto en
    instalaciones nuevas; quien ya eligiera un tema de editor lo conserva.
  - La cabecera del editor de celda es ahora un rail redondeado y ligeramente
    elevado con un icono del tipo de contenido detectado, y el pantalla
    completa es un pequeño chip tipo sticker que por fin muestra su propio
    atajo (F11) en lugar de un icono anónimo.
  - **Las pantallas vacías son ahora una familia**, no cuatro líneas grises sin
    relación: un único marco compartido (`EmptyState`) con un lavado de
    halftone, un medallón contorneado con el glifo y sitio para una pista,
    adoptado por el árbol de conexiones, la consola, las consultas guardadas y
    un resultado vacío.
  - **El nuevo logo comic sustituye a la marca antigua del cuervo/runas en todas
    partes**: se han regenerado desde él todos los tamaños de icono de app e
    instalador (Windows, macOS, Linux, además de los sets de Android/iOS), el
    workspace vacío muestra el lockup completo, la tarjeta de Acerca de lidera
    con la marca sobre un lavado de halftone, las pantallas vacías la muestran
    en su medallón con el glifo de cada estado como chapa en la esquina (sobre
    un campo de puntos que ahora cubre toda la superficie, iluminado por un
    bloom azul bajo la marca) y la pestaña del navegador en dev por fin tiene
    favicon. Los originales viven en el nuevo directorio `brand/`, fuera de
    `public/`, para que 2,5 MB de arte fuente no acaben en cada instalador;
    `public/image/` guarda solo lo que la app pinta, al tamaño al que lo pinta.
  - El icono de Windows se ha rehecho para los tamaños pequeños: el arte se
    recorta a su propio contenido (el margen transparente del original costaba
    ~10% de cada lienzo), cada talla se remuestrea con halvings 2:1 sucesivos y
    un unsharp suave a 32px o menos, e `icon.ico` incluye ahora la escalera
    completa —16/20/24/32/40/48/64/96/128/256—, con las entradas de 20px y 40px
    que Windows pide al 125% y 250% de escalado y que antes tenía que
    improvisar reescalando una vecina. La "H" se lee en la barra de título, la
    barra de tareas y el Explorador en vez de convertirse en un borrón azul.
  - **Nuevo splash de arranque**: la marca sobre un lavado de halftone y un
    bloom azul, en pantalla medio segundo y fuera. Es una capa dentro de la
    ventana existente, no una segunda ventana de Tauri, y nunca bloquea ni
    espera a la restauración de sesión.
  - Microdetalles: los tiradores de redimensionado son redondeados y se vuelven
    azules al agarrarlos; los puntos de estado de conexión llevan un halo suave
    de su propio color (los pilotos del cilindro del logo); saltar a una
    preferencia desde la paleta de comandos la hace parpadear en azul una vez
    antes de asentarse en su anillo; los dos avisos de estado que usaban un
    borde más claro que el resto ahora coinciden.

### Corregido

- **Cambiar entre claro/oscuro en un tema integrado que no fuera uno de los
  dos por defecto de HuginnDB lo reseteaba a `HuginnDB Dark`/`HuginnDB Light`
  en lugar de cambiar a la contraparte propia de ese tema (issue #132).**
  `setActiveMode` buscaba el destino con
  `BUILT_IN_THEMES.find(t => t.id === mode)` — una coincidencia literal
  contra el _string_ de modo `"dark"`/`"light"`, que solo resolvía a los dos
  temas cuyo `id` coincide justo con su modo. Cualquier otro preset (Claude,
  Dim, Solarized Dark, Neon, Summer, High Contrast) no encontraba nada,
  caía en silencio en una rama muerta que mutaba `mode` sobre un tema que
  nunca llegaba a escribirse de vuelta en `customThemes`, y el selector
  claro/oscuro de la barra simplemente dejaba al usuario en el HuginnDB por
  defecto que coincidiera con el modo destino. Se arregla dando a cada tema
  integrado un `pairId` explícito que apunta a su contraparte claro/oscuro
  (`lib/themes.ts`), y haciendo que `setActiveMode` resuelva a través de él
  en vez de adivinar a partir del string de modo. Esto es también el motivo
  por el que ahora cada tema integrado necesita una contraparte real — ver la
  entrada de Cambiado de arriba.
- **Sustituir un icono de la app ya no deja el anterior embebido en el
  binario.** `tauri_build::build()` solo declara `tauri.conf.json` y
  `capabilities/` como entradas de compilación, y cargo rastrea _únicamente_ lo
  que un build script declara — así que cambiar `icons/*` dejaba el crate como
  fresco mientras las dos copias del icono que se hornean al compilar (el
  recurso Win32 del ejecutable y el `default_window_icon` del contexto
  generado) conservaban el arte anterior, sin error alguno y sin que ninguna
  recompilación del frontend lo arreglara. `build.rs` declara ahora los seis
  ficheros de icono, de modo que tocar uno fuerza el reenlazado.
- El marcador del entorno activo en el rail izquierdo nunca se veía: estaba
  desplazado 8px fuera de un botón a ancho completo, lo que lo dejaba más allá
  del `overflow-hidden` del shell. El botón de solo lectura que renderizan las
  ventanas secundarias arrastraba el mismo fallo y se corrige con él.

- **Una "New window" secundaria mostraba todas las conexiones guardadas de
  todos los entornos, sin ningún rail que las distinguiera.**
  `EnvironmentRail` y `EnvironmentSwitcher` ya se ocultaban fuera de la
  ventana principal (gotcha #8 — solo main escribe `tab_state.json`), pero
  nada rellenaba los filtros de visibilidad de conexiones/bases de datos
  (`useUi.visibleConnections` / `databaseVisibility` /
  `collapsedConnections`) en una ventana secundaria tampoco, ya que
  `restoreSession`/`switchTo` estaban ambos bloqueados a la ventana
  principal. Como los perfiles de conexión son globales, no están
  particionados por entorno, el árbol caía a su comportamiento por defecto
  de "sin filtro": mostrar todo. `list_environments` ya devuelve, de solo
  lectura, el `launch` completo de cada entorno, así que el arreglo se queda
  en el frontend: `useEnvironments.load()` ahora siembra los filtros propios
  de una ventana secundaria a partir del entorno que esté activo, y
  `switchTo()` ganó una rama real para ventanas que no son la principal que
  redirige esos filtros localmente — sin tocar nunca `set_active_environment`,
  los pools, las pestañas ni `tab_state.json`. Cada ventana ya tiene su
  propio proceso de JS y su propia instancia de Zustand, así que esto no
  puede filtrarse entre ventanas. `EnvironmentRail`/`EnvironmentSwitcher`
  ahora se renderizan en toda ventana, con crear/renombrar/eliminar/reordenar
  (las acciones que sí escriben el archivo compartido) ocultas fuera de
  main — así que varias ventanas pueden estar cada una en un entorno
  distinto a la vez, de forma independiente.

- **Cambiar el modo de vista de una tabla (tabla/lista) en una ventana lo
  cambiaba en silencio en el resto de ventanas y pestañas abiertas.** El
  conmutador escribía `documentViewMode`, un campo dentro del único bloque
  `Preferences` que el backend difunde a propósito a todas las ventanas al
  guardar (la mayor parte de `Preferences` es efectivamente de toda la
  aplicación, por ejemplo la altura de fila). Se ha movido al estado de
  vista propio de cada pestaña de tabla (`TabViewState`/`PersistedTab`), el
  mismo mecanismo que ya se usa para los filtros/orden/búsqueda de una
  pestaña — ahora cada pestaña guarda su modo de fila de forma independiente
  del resto de pestañas y ventanas, sembrado una sola vez desde el valor por
  defecto global (sin cambios) la primera vez que se abre.

- **El rail de entornos ahora se desplaza, y Tema/Ajustes siguen siendo
  alcanzables.** El rail era una única columna plana con su pie fijado por
  `mt-auto`, que solo fija mientras hay espacio libre. En torno a ocho o nueve
  entornos, los avatares llenaban el rail y empujaban el interruptor de tema y
  el botón de ajustes más allá de su borde inferior, y el `overflow-hidden`
  del shell los recortaba — sin scroll para alcanzarlos y sin ninguna pista de
  que algo se hubiera perdido. Los entornos ahora se desplazan en su propio
  contenedor, y "+", Tema y Ajustes se sitúan en una franja fija debajo. "+"
  se sacó a propósito de la lista que se desplaza: crear un entorno no
  debería significar desplazarse más allá de todos los que ya tienes.

- **Una conexión multi-base de datos dejaba de poder explorarse tras unos
  minutos de inactividad, aunque el árbol la siguiera mostrando como
  conectada.** Expandir una base de datos en una conexión de tipo servidor
  (Postgres/MySQL/SQL Server sin `database` fija) abre un pool sintético por
  base de datos (`<parent>::db::<database>`), y desde la 1.13.0 uno de esos
  que lleva inactivo se cierra por el proceso de fondo tras
  `connections.childIdleTtlSecs` (5 minutos por defecto) — a propósito, para
  que la huella de conexiones de una sesión larga no crezca sin parar. Lo que
  no se tuvo en cuenta es que la conexión _padre_ que el árbol realmente
  refleja se mantiene sana todo el tiempo (su propio keepalive sigue teniendo
  éxito), así que el árbol seguía informando "conectado" mientras el pool
  hijo que el siguiente clic necesitaba de verdad ya no estaba —
  apareciendo como un error `not connected: <id>`, o, cuando el clic solo
  disparaba la lista de columnas, un esqueleto de carga indefinido (el store
  `loadColumns`/`loadIndexes` no tenía manejo de errores, así que una llamada
  rechazada simplemente se quedaba colgada). Cualquier comando que resuelve
  un id de conexión ahora reabre de forma transparente un pool hijo cerrado,
  con las mismas credenciales cacheadas que usó la primera vez, antes de la
  búsqueda habitual — el cierre en sí no cambia, solo su efecto en el
  siguiente clic. Las llamadas de solo lectura a metadatos (`list_tables`,
  `list_columns`, el ping del keepalive, …) ganaron también un tiempo límite
  de 20 segundos, así que un socket que un NAT o un firewall cerró en
  silencio a medias falla rápido en vez de colgarse — antes el único tiempo
  límite en todo el backend protegía el cierre de pools, no las consultas.
  SQL Server necesitó un arreglo más debajo de este: una consulta cancelada
  por ese nuevo tiempo límite podía devolverse al pool como sana con su flujo
  TDS a medio leer — una sesión ahora solo vuelve al pool inactivo una vez
  que su resultado se ha clasificado realmente como dejando el flujo en un
  punto limpio, nunca ante un future cancelado.
- **El conector `huginndb-mcp` podía fallar una llamada por lo demás exitosa
  con `invalid input: empty reply`, de forma más visible contra SQL Server.**
  El fallo está en el puente local que usa el sidecar para reutilizar los
  propios pools de la app de escritorio: toda llamada a una tool empieza con
  un viaje de ida y vuelta `EnsureConnected` cuyo valor de éxito es
  `Value::Null`, y el formato de cable envolvía el payload de una respuesta
  en un `Option<Value>` a secas — que `serde_json` colapsa a "ausente" ante
  _cualquier_ `null`, sea lo que sea que envuelva. Un éxito legítimo con
  `Value::Null` era por tanto indistinguible de no haber recibido respuesta
  alguna. El fallo es independiente del driver — puede darse en la primera
  llamada de cualquier tool contra cualquier conexión mientras el bridge esté
  activo — pero SQL Server fue donde se notó, probablemente porque los demás
  drivers se probaron con el sidecar en su modo independiente (sin bridge),
  donde esta ruta de código nunca se ejecuta. El payload ahora se envuelve un
  nivel más adentro para que el cable pueda distinguir "un valor null" de
  "ningún valor"; la versión del protocolo del bridge se incrementa en
  consecuencia, así que un sidecar antiguo que un cliente mantenga vivo a
  través de una actualización de la app degrada a su propio pool local en vez
  de malinterpretar la nueva forma a mitad de una llamada.

## [1.15.0] — 2026-08-14

### Añadido

- **Los entornos pueden llevar una imagen de avatar propia.** Hasta ahora un
  entorno se dibujaba siempre con sus iniciales sobre el color de acento, lo que
  deja de distinguir en cuanto dos empiezan por la misma letra ("Cliente A" /
  "Cliente B") — justo el caso que el rail existe para hacer reconocible de un
  vistazo. El diálogo de crear/renombrar acepta ahora una imagen: elígela con el
  diálogo nativo de archivos, o suelta un archivo directamente sobre la vista
  previa del avatar. Sustituye a las iniciales en el rail, en el selector de
  espacios de trabajo y en la propia vista previa del diálogo, y el selector de
  la barra de estado también la muestra en lugar de su punto de color (una
  imagen sí se reconoce a 12px, que es la razón por la que las iniciales nunca
  estuvieron ahí). Quitarla vuelve a las iniciales.
  Dónde se guarda: en línea, dentro del campo `Environment.icon` que ya existía
  — como una URL `data:`, así que no hay cambio de esquema ni migración de
  datos. Lo que elija el usuario se recorta cuadrado desde el centro y se
  recodifica a 128px (WebP donde el webview sabe codificarlo, PNG en el resto)
  antes de guardarse, lo que mantiene el payload en pocos KB: `icon` viaja por
  `tab_state.json` en cada escritura del entorno, así que una foto a resolución
  completa engordaría un archivo que la app reescribe constantemente. Guardar la
  imagen en línea en vez de como archivo en el directorio de configuración
  significa que no tiene ciclo de vida propio — se copia, se descarta y se
  escribe junto al entorno, así que no hay huérfanos que barrer ni un segundo
  modo de fallo en el que el JSON apunte a un archivo que ya no está.
  `icon` es la ranura en la que escribía el antiguo selector de iconos de
  lucide, y un entorno que aún guarde una clave de icono heredada sigue cayendo
  a las iniciales igual que desde que ese selector se eliminó: la rama de imagen
  se activa por que el valor sea una URL `data:image/`, no por que el campo no
  esté vacío.
  Un comando nuevo en el backend (`read_image_data_url`) hace la lectura, porque
  el diálogo nativo devuelve una _ruta_ que el webview no puede abrir por sí
  mismo. Valida el formato por los bytes mágicos del archivo y no por su
  extensión, y rechaza cualquier cosa por encima de 12 MB, así que un archivo
  inservible se rechaza con un mensaje claro en vez de convertirse en una URL
  `data:` que ningún `<img>` va a cargar. La ruta de arrastrar y soltar no pasa
  por él — el navegador ya tiene los bytes.

- **Ya se publican artefactos de release para Linux.** Cada release _podía_
  haberlos incluido desde hace tiempo: `bundle.targets` en
  `tauri.conf.json` lista `deb` y `appimage` desde la 1.7.0, y
  `.github/workflows/release.yml` ya tenía tanto la pata `ubuntu-22.04` de la
  matriz como sus dependencias de apt (`libwebkit2gtk-4.1-dev`,
  `libappindicator3-dev`, `librsvg2-dev`, `patchelf`). La pata estaba
  simplemente comentada, así que nunca se compilaba nada y los usuarios de
  Linux tenían que compilar desde el código — el propio README lo decía. Ahora
  está activada, y una build con tag adjunta `.deb` + `.AppImage` de `x86_64`
  junto al instalador de Windows, con una nueva sección "From a release
  (Linux)" en el README que cubre ambos. `ubuntu-22.04` es una elección
  deliberada frente a `ubuntu-latest`: un AppImage enlaza contra la glibc de la
  máquina que lo construyó, así que compilar en una imagen más nueva
  reduciría en silencio el rango de distros donde puede arrancar. La matriz ya
  tenía `fail-fast: false`, así que un fallo en la pata de Linux no puede
  tumbar los artefactos de Windows, y el paso de `tauri-action` ha ganado
  `retryAttempts: 3` porque ahora hay dos patas publicando artefactos del
  updater en una misma release: la action fusiona la entrada de cada plataforma
  en el `latest.json` existente en vez de reemplazar el asset, así que no se
  pierde ninguna entrada, pero dos patas en paralelo pueden competir al
  borrarlo — reintentar todo el ciclo descargar-fusionar-subir es la mitigación
  prevista por upstream. Todavía no se ha probado con un tag real — el
  `workflow_dispatch` del workflow construye un borrador contra un tag
  desechable justo para este tipo de comprobación.

### Cambiado

- **El nombre del entorno en el rail izquierdo es algo más grande.** Estaba a
  10px, que en una pantalla de 1080p se quedaba por debajo de lo que necesita el
  único trozo de interfaz de entornos que está siempre visible para leerse de
  reojo. Ahora son 11px con el espaciado entre letras más cerrado, así que sigue
  cabiendo aproximadamente el mismo número de caracteres en los 72px del rail
  antes de truncar, y el nombre del entorno activo va en peso medio — "en qué
  entorno estoy" se lee ahora también por la tipografía, no solo por el tinte
  del fondo.

### Corregido

- **El README mandaba a los usuarios de Windows a un `.msi` que ya no existe.**
  El empaquetado de Windows pasó de WiX/MSI a NSIS en la 1.7.0 (ver gotcha #21
  en `CLAUDE.md`: WiX v3 quedó archivado en febrero de 2025 y su `light.exe`
  dejó de ejecutarse en los runners de Windows de GitHub), así que las
  releases llevan varias versiones publicando un `-setup.exe` mientras tres
  sitios del README — la instrucción de descarga, el consejo del SHA-256 en la
  nota de SmartScreen y la línea de empaquetado del stack — seguían nombrando
  el MSI. Quien siguiera el README buscaba un archivo que no está adjunto a la
  release.

- **Plegar un grupo de conexiones en una pantalla lo plegaba silenciosamente en todas las demás donde estuviera visible a la vez.** `useConnectionGroupCollapse` (`src/lib/connection/useConnectionGroups.ts`) lo comparten el menú Archivo, el diálogo de gestión de conexiones, el selector de la barra de estado y el árbol de Esquema del entorno; en el modo por defecto "recordar" leía `prefs.ui.collapsedConnectionGroups` como un selector de Zustand en vivo, así que cada instancia montada se volvía a renderizar a partir del mismo valor en cada toggle. Abrir el diálogo de gestión de conexiones con el árbol de un entorno ya con un grupo abierto lo mostraba también abierto ahí (esperable — es la misma disposición recordada), pero plegar ese grupo _dentro del diálogo_ también lo plegaba en vivo en el árbol de detrás, porque ambas pantallas eran en realidad una única instancia compartida del estado de plegado, no vistas independientes que simplemente partían de la misma disposición guardada. El hook ahora siembra, al montarse, un override de sesión propio de cada instancia a partir del conjunto persistido, y cada toggle — en los tres modos, no solo en los forzados "expandido"/"plegado" — solo toca el estado local de esa instancia; los toggles en modo "recordar" siguen escribiéndose a disco, así que la _siguiente_ pantalla en montarse (incluido un futuro arranque de la app) recoge la disposición más reciente, pero una pantalla que ya está abierta en otro sitio deja de recolocarse sin que el usuario lo pida. No cambia ninguna preferencia ni el formato en disco.

- **El botón "Reiniciar ahora" no daba ningún feedback tras pulsarlo, lo que invitaba a pulsarlo varias veces.** `installAndRelaunch` (`src/stores/update.ts`) pasaba directamente de `readyToRestart` a un estado transitorio `ready` justo antes de `installUpdate()`/`relaunchApp()` — pero todo lo que ocurre en medio (una comprobación asíncrona del sidecar de MCP, y su diálogo de confirmación si algún cliente lo tiene abierto ahora mismo) se ejecutaba mientras el store seguía reportando `readyToRestart`, así que tanto `UpdateBanner` como la tarjeta de actualizaciones de Ajustes → Acerca de seguían mostrando la etiqueta inactiva "Reiniciar ahora" / "Instalar y reiniciar" con el botón totalmente pulsable. Ahora se fija un nuevo estado `installing` de forma síncrona en el instante en que se ejecuta el handler del click, antes de cualquier `await`; ambos componentes deshabilitan su botón de instalar (y en el banner también los controles de descarte) y muestran un spinner con la etiqueta "Reiniciando…" durante todo ese hueco. `installAndRelaunch` también corta en seco si se vuelve a invocar mientras ya está en `installing`/`ready`, así que una doble invocación accidental no puede encolar una segunda instalación aunque un click se cuele.

## [1.14.0] — 2026-08-13

### Añadido

- **La paleta de comandos (Ctrl/Cmd+K) ya es un lanzador de verdad.** Antes
  indexaba tres cosas — las conexiones guardadas, las tablas de la conexión
  seleccionada y un puñado fijo de acciones (nueva consulta, preferencias,
  tema, idioma) — filtradas con un `includes()` de subcadena. Ahora indexa
  trece grupos y los ordena por relevancia:
  - **Cada preferencia individual**, al estilo de VS Code: escribir `#ajuste`
    (o simplemente `wrap`) encuentra «Ajustar líneas largas», muestra su valor
    actual y Enter abre Preferencias en esa sección y baja hasta _esa fila_,
    resaltándola. Los ajustes booleanos además se pueden alternar sin salir de
    la paleta con Alt+Enter, que la deja abierta para que el valor se actualice
    bajo el cursor. Cada atajo reasignable se indexa igual, con su combinación
    actual.
  - **La documentación** (cada documento de la app, más Novedades,
    Informar/sugerir, Buscar actualizaciones, Acerca de y la página de MCP).
  - **Navegación**: pestañas abiertas (Enter salta, Alt+Enter cierra),
    conexiones guardadas (Alt+Enter desconecta una activa), entornos, las bases
    de datos de un servidor multi-base, tablas y vistas de _todas_ las
    conexiones abiertas y no solo de la seleccionada, consultas guardadas y las
    últimas 20 entradas del historial.
  - **Acciones** que solo existían en un menú: nueva conexión, gestionar
    conexiones, importar/exportar perfiles, desconectar todo, recargar el
    esquema, recargar los datos de la tabla activa, cerrar/fijar la pestaña
    activa, cerrar todas, nueva ventana, restablecer la disposición, flotar el
    panel activo y un interruptor por cada panel del dock.

  La búsqueda también cambió de forma: las entradas se puntúan en vez de
  filtrarse (`src/lib/commandPalette/fuzzy.ts` — prefijo gana a inicio de
  palabra, que gana a subcadena, que gana a subsecuencia, con bonus por
  densidad de coincidencias y límites de palabra, y desempate por longitud),
  los caracteres que coincidieron se resaltan en cada fila, los grupos se
  ordenan por su mejor coincidencia para que las cabeceras sigan teniendo
  sentido, y los comandos que de verdad usas suben al principio bajo el
  encabezado «Usados recientemente» (persistido en `localStorage`).

  Los prefijos de modo acotan la búsqueda como en VS Code — `>` acciones,
  `@` tablas, `#` ajustes, `?` ayuda, `:` ir a — mostrados como chips
  clicables mientras el campo está vacío y recorribles con Tab, para que una
  conexión con miles de tablas no sepulte las acciones.

- **`Ctrl/Cmd+Shift+P` abre la paleta en modo solo acciones** (paridad con
  VS Code). Reasignable como el resto, en Ajustes → Atajos.

- **La paleta puede indexar bajo demanda las tablas de un servidor
  multi-base.** Una conexión a todo el servidor arranca con solo la lista de
  _bases de datos_ cargada — las tablas de cada base llegan en su propio
  fragmento `<padre>::db::<nombre>`, y solo cuando algo abre esa vista — así que
  un servidor recién conectado ofrecía bases de datos y ninguna tabla que
  buscar. El modo `@` ahora incluye también una entrada «Indexar todas las bases
  de datos de X» mientras alguna siga sin indexar; al ejecutarla abre esas
  vistas de tres en tres y deja la paleta abierta para que las tablas aparezcan
  bajo el cursor. Es una acción deliberada y no un abanico automático en cada
  pulsación porque cada vista es otro pool de conexiones — el mismo
  razonamiento, y el mismo límite de concurrencia y cortacircuitos por límite de
  conexiones, que la búsqueda entre bases del explorador de esquema
  (`src/lib/commandPalette/warmSchema.ts`). Se respeta el subconjunto de «bases
  de datos a mostrar» de cada conexión, así que una base oculta en el árbol
  sigue oculta en la paleta.

- **Importar/exportar un tema desde Ajustes → Apariencia.** Un icono de
  exportar junto al selector de modo del editor de temas escribe el tema
  activo (integrado o personalizado) a un archivo JSON mediante el diálogo
  nativo de guardar; un icono de importar en la cabecera de la lista de temas
  lee uno de vuelta como un tema personalizado nuevo (siempre con un id
  nuevo, nunca choca con uno existente) y cambia a él de inmediato, igual que
  ya hace duplicar un tema. El formato del archivo es un pequeño envoltorio
  versionado (`src/lib/themeTransfer.ts`) — los temas viven enteramente en el
  almacén respaldado por `localStorage` del frontend, así que lo único que
  necesita el backend es un comando `write_text_file` estrecho, análogo al
  `read_text_file` que ya usa la importación de SQL.

- **Un tema integrado "Summer"** — una paleta clara y cálida (fondo de arena
  soleada, un único acento turquesa-océano para brand/ring, tonos coral en
  primary y destructive) que se suma a los temas integrados existentes en
  `src/lib/themes.ts`.

- **Tema por entorno.** El diálogo de crear/renombrar entorno
  (`EnvironmentEditorDialog`) incorpora un selector de tema junto al campo ya
  existente de color, listando todos los temas integrados y
  personalizados más una opción "Predeterminado". Asignar un tema a un
  entorno lo aplica automáticamente cada vez que se entra en él — al arrancar
  la app o al cambiar de entorno (`switchTo`) — y quitarlo (la opción
  predeterminada, siempre disponible) vuelve al tema que tengas configurado
  en Ajustes → Apariencia. La asignación se superpone al almacén de temas
  existente (`useThemeStore.setEnvironmentOverride`) en vez de sobrescribir
  el tema predeterminado persistido, así que volver a un entorno sin tema
  asignado nunca pisa la elección habitual del usuario. Se persiste en el
  backend como `Environment.themeId` (`tab_state.json` v4; `None` por
  defecto, así que los entornos existentes no se ven afectados).

- **Doble clic en el borde de una columna de la rejilla para ajustarla a su
  contenido** (el gesto de HeidiSQL). Un valor demasiado largo para el ancho
  por defecto —la configuración serializada de un widget, un párrafo de
  descripción— ya no obliga a abrir el editor de celda solo para leerlo: la
  columna crece hasta el valor más ancho que hay en pantalla y se queda así
  (se persiste por tabla, igual que un redimensionado manual). Con
  `Ctrl`/`Cmd` pulsado el doble clic ajusta todas las columnas de golpe, y el
  tooltip del tirador explica ambos gestos. La barra de herramientas de la
  rejilla incorpora además un botón para la versión "ajustar todas", para que
  no dependa de un gesto que hay que conocer — tanto en pestañas de tabla como
  en resultados de consulta. El ajuste se mide sobre el texto tal y como se
  _dibuja_ (se aplican el modo de visualización de BIT, el marcador de NULL y
  el tope de "truncar texto largo en") y se limita a 900 px, para que una columna ancha no eche el resto de la fila fuera de la
  pantalla; arrastrando a mano se sigue pudiendo ir tan ancho como se quiera.

- **La barra de herramientas de la rejilla es responsive.** En un panel
  estrecho se partía en dos filas, con el clúster de filtros en una y el de
  acciones en la otra. Ahora las acciones se salen de la barra: mide su propio
  ancho (vive en un panel del dock, así que una media query mediría lo que no
  toca) y colapsa en dos pasos — primero las acciones de datos con etiqueta
  (insertar, importar, exportar, actualizar en masa) pasan a un único menú
  `⋯`, y con el panel ya realmente estrecho lo hace todo lo demás, quedando
  solo el buscador y el `⋯`. Los chips de filtros activos se pliegan en un
  único chip "2 filtros" cuyo desplegable sigue quitándolos uno a uno, y el
  recuento de filas y el tiempo de consulta se van al menú en vez de
  desaparecer — salvo en una rejilla sin nada más que colapsar (un resultado de
  consulta ad-hoc), donde se quedan en la barra porque no habría menú donde
  leerlos.

- **La estructura exterior de la ventana ahora se organiza con una barra de
  actividad en vez de cinco paneles dockview de igual rango.** Esquema,
  Guardadas, Consola, el editor de celda y el espacio de trabajo vivían como
  grupos dockview intercambiables que se podían arrastrar, tabular juntos o
  flotar — lo que sugería visualmente que se podían crear más "espacios de
  trabajo", algo que nunca fue la intención. Consola ahora se ancla abajo
  con su propia cabecera colapsable; Guardadas se colapsa/expande desde un
  botón en una nueva barra de actividad derecha; el editor de celda es un
  simple split flexbox _dentro_ de la isla del espacio de trabajo en vez de
  un grupo dockview hermano (así que abrirlo o cerrarlo ya no puede disparar
  el efecto secundario de dockview de redistribuir proporcionalmente los
  paneles vecinos); y el propio espacio de trabajo es una tarjeta "isla" fija
  y no arrastrable con su propia cabecera, que envuelve sin cambios el área
  de pestañas de tabla/consulta abiertas. Cada panel ahora anima su apertura
  y cierre (200ms con suavizado, suspendido durante un arrastre activo del
  separador para que el redimensionado siga siguiendo el puntero 1:1) en vez
  de aparecer/desaparecer de golpe. Nuevos botones de mostrar/ocultar al
  estilo VS Code en la esquina superior derecha de la cabecera (iconos
  `PanelLeft`/`PanelBottom`/`PanelRight`) muestran u ocultan Esquema, Consola
  y Guardadas de forma independiente a las barras de actividad. El estado de
  la disposición se trasladó a un almacén pequeño
  (`stores/session/panelLayout.ts`, persistido por separado del antiguo blob
  de dockview) porque la API de paneles de dockview no tiene `setVisible`
  para un panel normal — no hay forma de colapsar uno a 0px sin eliminarlo,
  lo que redistribuye a sus vecinos. El dockview anidado dentro de la isla
  del espacio de trabajo (pestañas de tabla/consulta abiertas, su propia
  geometría de división/flotación, arrastrar y soltar) no se ve afectado en
  absoluto.

- **La barra de actividad izquierda ahora es una columna de entornos al
  estilo Discord/Teams** en vez de un único botón genérico "Esquema". Cada
  entorno tiene su propio avatar (iniciales sobre su color de acento, en un
  cuadrado redondeado — ver la siguiente entrada) con su nombre debajo; un
  "+" al final abre el mismo diálogo de creación que ya tenía el selector de
  la barra de estado. Al hacer clic en un entorno que no es el activo se
  cambia a él _y_ se abre el panel de Esquema en un solo gesto; al hacer clic
  en el ya activo simplemente se colapsa/expande Esquema — ya no hay un
  botón de alternancia dedicado aparte, porque sería redundante con este.
  Al hacer clic derecho sobre un avatar se abre el mismo menú de
  renombrar/eliminar que ya ofrecían las filas del desplegable del selector
  de la barra de estado, así que gestionar entornos ya no exige bajar hasta
  la barra de estado. El selector de la barra de estado (`EnvironmentSwitcher`)
  no cambia y sigue ahí — esto es una forma adicional de cambiar de entorno,
  no un reemplazo.

- **Los entornos se representan como un avatar de iniciales al estilo Teams**
  — hasta dos letras derivadas del nombre, sobre el color de acento del
  entorno (un gris neutro si no hay ninguno asignado), con el color del texto
  elegido automáticamente para mantener el contraste. Sustituye al antiguo
  selector de iconos de lucide en el diálogo de crear/renombrar entorno, que
  ha desaparecido; el diálogo ahora muestra una vista previa del avatar en
  vivo junto al campo de nombre. Se usa en todos los sitios donde se muestra
  un entorno: la nueva columna, las tarjetas del selector de entorno del
  espacio de trabajo vacío, y la vista previa del diálogo de crear/renombrar.
  El selector de la barra de estado mantiene deliberadamente un simple punto
  de color en su lugar — a esa escala las iniciales son demasiado pequeñas
  para leerse bien. `Environment.icon` no se lee pero se mantiene en el
  contrato de datos (tanto en el almacén del frontend como en la estructura
  `tab_state.json` del backend — no hizo falta ninguna migración) como el
  futuro hueco para una imagen personalizada subida por el usuario, que está
  pensada pero todavía no implementada: el componente del avatar está
  estructurado para que más adelante se pueda añadir una rama `<img>`
  respaldada por `env.icon`, con prioridad sobre las iniciales, sin tocar
  ningún punto donde ya se usa.

### Cambiado

- **Una pestaña del espacio de trabajo ya muestra el nombre de la tabla en
  lugar de quedarse sin sitio antes de llegar a él.** Con pestañas de varias
  conexiones abiertas, cada una imprimía `conexión · base · base.tabla` — la
  base de datos dos veces — y lo único que distingue una pestaña de otra, la
  tabla, era justo lo que se cortaba. La base aparece una sola vez, y la
  etiqueta se recorta por prioridad: el contexto de conexión (que se repite en
  todas las pestañas de esa conexión, y que el logo del driver ya señala) cede
  su ancho primero y el nombre conserva el suyo, separados por una línea fina
  en vez de otro `·` dentro de un nombre lleno de ellos. Al pasar el ratón por
  encima aparece la identidad completa — `esquema.tabla` cualificado y la
  conexión — con menos retardo que en un botón de la interfaz: en una pestaña
  recortada el tooltip es la única forma de leer el nombre entero.

- **Las pestañas recortadas se difuminan en vez de cortarse**, como en la tira
  de pestañas de un IDE: tanto un nombre demasiado largo para su pestaña como
  la pestaña que queda a caballo del borde de una tira con más pestañas de las
  que caben, que antes se cortaba a media letra contra una pared vertical.
  Cada difuminado aparece solo donde algo se corta de verdad: un nombre que
  cabe conserva su final, y una tira con sitio de sobra mantiene los bordes
  limpios. El borde difuminado sirve además de pista de que hay más pestañas
  en esa dirección.

- **El botón «∨» de la tira parece un botón**: superficie y borde propios
  sobre el fondo hundido de la tira. Ya no imprime el número de pestañas
  ocultas junto al galón — el galón ya significa «hay más», la propia lista
  enseña cuántas, y el número solo competía con los nombres de al lado.

- **El menú de pestañas desbordadas («∨ N») es la tira de pestañas puesta de
  canto.** Reutiliza el propio componente de cada pestaña oculta, así que cada
  fila llegaba con la geometría _horizontal_ de la tira: un margen de 7px por
  un solo lado y el ancho de recorte de la tira dentro de un desplegable con
  sitio de sobra, más dos barras de scroll, una de ellas horizontal. Los chips
  se quedan — mismo fondo hundido, mismo relleno y misma elevación, así que el
  desplegable se lee como parte de la misma superficie — pero ahora cada uno
  ocupa todo el ancho, con el nombre en una línea y su conexión debajo, el
  activo marcado con un raíl a la izquierda en vez de un borde superior, y el
  desplegable solo se desplaza en vertical.

- **Eliminado el botón «⊞ N» de la tira de pestañas.** Abría el selector modal
  a dos píxeles de la lista de desbordadas «∨ N», que responde a lo mismo sin
  salir de la barra. El diálogo sigue estando en `Ctrl`/`Cmd`+`P`
  (reasignable), que es lo único que busca por nombre entre todas las pestañas
  abiertas.

### Corregido

- **Saltar a una pestaña o tabla de una vista por base de datos dejaba el
  espacio de trabajo apuntando a otro sitio.** Una pestaña de un servidor
  multi-base lleva el id sintético `<padre>::db::<base>`, pero
  `useConnections.active` solo contiene ids de perfil de primer nivel
  (`markConnected` se ejecuta en `connect()`; una vista de base la abre
  `open_database_view`), y `App.tsx` limpia `selectedConnectionId` en cuanto no
  está en ese conjunto. Así que seleccionar un id hijo se deshacía un render
  después y se reemplazaba por el pool que llegara primero, de forma no
  determinista. Tanto el conmutador de pestañas (que ya lo tenía) como las
  nuevas entradas de tablas/pestañas de la paleta resuelven ahora el perfil
  propietario con `parentConnectionId`; la pestaña conserva el id hijo, que es
  lo que acota sus consultas.

- Un clic simple en el tirador de redimensionado de una columna ya no
  reescribe en `prefs.json` el ancho que esa columna ya tenía.

- Cerrar una pestaña desde la lista de desbordadas («∨ N») dejaba atrás una
  fila muerta, con el id interno de la pestaña donde estaba su nombre. dockview
  construye ese desplegable una sola vez, al abrirlo, y nunca lo reconstruye:
  ahora se cierra junto con la pestaña que se cerró desde él.

## [1.13.0] — 2026-08-12

### Añadido

- **Driver de Microsoft SQL Server** — el quinto motor, pedido por usuarios
  que usan HuginnDB contra SQL Server. Conectar (con soporte de túnel SSH),
  explorar bases de datos/esquemas/tablas/vistas/índices con recuento de filas
  y tamaños, ejecutar T-SQL en el editor, paginar/ordenar/filtrar la rejilla,
  editar celdas, insertar y borrar filas, actualización masiva, y el panel de
  usuarios/permisos. Las instancias nombradas (`HOST\SQLEXPRESS`) se resuelven
  a través del SQL Browser, y un interruptor de "confiar en el certificado del
  servidor" —activado por defecto— hace utilizables los certificados
  autofirmados que presentan la mayoría de instalaciones on-premise. En las
  compilaciones de Windows el diálogo de conexión ofrece además autenticación
  Windows (NTLM) con un `DOMINIO\usuario` explícito; el modo se oculta en el
  resto de plataformas porque el driver subyacente solo lo compila en Windows.
- El servidor mínimo soportado es **SQL Server 2012**: la paginación usa
  `OFFSET … ROWS FETCH NEXT … ROWS ONLY`, que no existe antes de esa versión.
- El motor nuevo entra en la contabilidad de conexiones descrita más abajo en
  vez de dimensionarse por su cuenta: `tiberius` no trae pool, así que el pool
  de sesiones propio de HuginnDB toma la misma asignación por servidor que
  cualquier otro driver, se cierra explícitamente al desconectar en lugar de
  esperar a que se libere solo, y suelta las sesiones que llevan cinco minutos
  sin usarse.
- **Ajustes → Conexiones** — una sección de preferencias nueva para el pool de
  conexiones: el techo de una conexión y el de una vista por base de datos,
  cuántas vistas por base de datos puede mantener abiertas una conexión,
  cuánto sobrevive una sin usar y el intervalo del keepalive. Muestra también,
  en vivo, cuántos pools está manteniendo HuginnDB, con un botón para liberar
  los de por base de datos. Esa visibilidad es la mitad del asunto: un
  `too many connections` solo es accionable si puedes ver tu propia
  aportación al problema.
- **Presupuesto de conexiones por servidor.** La unidad de contabilidad pasa a
  ser el servidor, no la conexión guardada. `Máximo de conexiones por
servidor` es toda la asignación que HuginnDB gastará contra un host,
  compartida por cada conexión y cada vista por base de datos que llegue a él
  — así que tres conexiones apuntando a la misma máquina PostgreSQL ya no
  reciben tres asignaciones independientes, que es exactamente cómo la huella
  llegó a no tener límite. Dos conexiones detrás de túneles SSH _distintos_
  que ambas dicen `localhost:5432` se tratan correctamente como servidores
  distintos; dos que conectan con usuarios distintos se tratan correctamente
  como el mismo, porque el límite del servidor es global.
  Cuando se agota la asignación de un servidor, abrir una vista de base de
  datos **cierra la vista que lleves más tiempo sin usar en ese mismo
  servidor** en vez de fallar — así explorar un servidor de doce bases de
  datos con un presupuesto de diez conexiones sigue funcionando. Si de verdad
  no hay nada que reclamar, el error nombra el presupuesto y dónde subirlo en
  lugar de soltar una cadena del driver.
- **Límite por conexión** — las conexiones tienen ahora un campo **Máximo de
  conexiones para este servidor**. La capacidad de conexión es un hecho del
  _servidor_, así que vive en la conexión: viaja con la exportación/
  importación de perfiles, se sincroniza por orígenes compartidos y el sidecar
  `huginndb-mcp` lo respeta automáticamente porque lee el mismo
  `profiles.json`. Vacío significa "usa la preferencia global".
- **`huginndb-mcp --max-connections <n>`** — techo del pool por conexión
  expuesta para el conector headless, con `2` por defecto. Ver la nueva
  sección "Connection footprint" en `docs/MCP.md`.
- **Compartir pools con el conector MCP** (Ajustes → Conexiones → _Compartir
  pools con el conector MCP_, desactivado por defecto). Con la opción
  activada, un sidecar `huginndb-mcp` en marcha deja de abrir sus propios
  pools y pide a la aplicación de escritorio que ejecute sus consultas. La
  máquina pasa entonces a tener **un presupuesto por servidor** por muchos
  clientes MCP que estén configurados — hasta ahora cada uno lanzaba su propio
  sidecar con sus propios pools, invisibles para la aplicación y entre sí. Dos
  consecuencias más que ya justifican el interruptor por sí solas: la
  actividad del conector aparece en la **Consola de la aplicación en vivo**,
  cada lectura y cada escritura según ocurren en vez de solo después en
  `mcp-audit.log`; y la aplicación vuelve a comprobar por su cuenta la
  política de escritura de cada conexión, con independencia de la comprobación
  del propio sidecar. El transporte es un listener solo de loopback con un
  token por ejecución guardado en un fichero `0600` junto a `profiles.json`.
  Cuando la aplicación no está en marcha, o la opción está desactivada, el
  conector se comporta exactamente igual que antes.
- `docs/CONNECTION_POOLING_ANALYSIS.md` — la auditoría de la que salen estos
  cambios: cómo asignaba conexiones el motor, la aritmética del peor caso, los
  hallazgos ordenados por gravedad y la arquitectura centrada en el servidor
  hacia la que apunta el trabajo restante.
- **Vista lista editable.** La vista de una tarjeta por fila deja de ser de
  solo lectura: ahora es un editor de documentos con la forma que hizo
  familiar MongoDB Compass. Los objetos y arrays anidados llegan **plegados** y
  se abren bajo demanda, cada campo es una línea numerada con su tipo en el
  margen derecho, y **hacer doble clic en un valor lo edita ahí mismo** (Enter
  o perder el foco confirma, Esc cancela, ∅ escribe NULL). El botón de
  expandir eleva el campo al mismo editor Monaco que usa la vista de tabla
  —modal o acoplado, siguiendo la preferencia `cellEditorMode` existente—, que
  es como se edita un subdocumento entero como JSON.
  En MongoDB el margen de tipos es un **selector**: elegir un tipo reescribe el
  campo como ese tipo BSON (el vocabulario completo de Compass — `Binary`,
  `UUID`, `Code`, `Timestamp`, `MinKey`/`MaxKey`, `BSONRegExp`, `BSONSymbol`,
  `Undefined` y los ya soportados), se pueden **añadir** campos (un `$set`
  sobre una ruta nueva, incluso dentro de un objeto anidado o añadido a un
  array) y **borrarlos** (un comando `unset_field` nuevo que emite `$unset`,
  detrás de la confirmación de acciones destructivas). El `_id` de un
  documento sigue siendo de solo lectura: un `$set` sobre él falla en el
  servidor, así que ofrecer la edición solo produciría un error.
  Editar un campo **anidado** lo direcciona por su ruta de actualización
  (`customData.format`, `tags.2`), de modo que un valor dentro de un
  subdocumento se escribe sin reescribir el documento que lo rodea.
- **Los resultados de MongoDB llevan ahora sus tipos BSON reales.**
  `QueryResult` gana un campo `row_types`: un árbol de tipos por celda que
  refleja la estructura del valor (`bson_type_tree`). El JSON de
  visualización es deliberadamente lossy — `Int32`, `Int64` y `Double` llegan
  todos como número JSON, y `ObjectId`, `Date` y `Decimal128` todos como
  cadena—, así que sin esto la vista lista habría tenido que adivinar el tipo
  a partir del valor y habría reescrito un `Long` como `Int` la primera vez
  que alguien corrigiera una errata en un campo sin relación. Los drivers SQL
  lo dejan sin poner; sus tipos de columna nunca fueron ambiguos.

### Cambiado

- **La vista lista funciona en todos los drivers.** Salió en la 1.11.0 como
  una representación exclusiva de MongoDB, pero el problema que resuelve —una
  fila ancha o anidada que se desplaza horizontalmente y aplasta sus valores
  anidados en una línea ilegible— no es exclusivo de MongoDB: una tabla de 40
  columnas, o una fila con una columna `jsonb` grande, tiene exactamente la
  misma forma. El interruptor de la barra de herramientas se ofrece ahora
  también en PostgreSQL/MySQL/SQLite, los valores son editables ahí por el
  mismo camino `update_cell` que la vista de tabla, y los valores anidados
  dentro de una columna JSON se pliegan como un subdocumento. Las tres
  acciones que solo tienen sentido en una base de datos documental —añadir
  campo, borrar campo, cambiar tipo— siguen ocultas en SQL, donde el conjunto
  de columnas de una fila pertenece a la tabla, no a la fila.
- **La preferencia de modo de vista se movió a Ajustes → Apariencia**, a un
  grupo nuevo **Vista de datos**, y perdió su redacción específica de MongoDB.
  Está junto al editor de temas porque responde a la misma pregunta ("qué
  aspecto tiene esto") en vez de a "cómo se comporta la rejilla", y ahora
  lleva tres opciones de la vista lista: si los valores anidados empiezan
  desplegados, si se muestra el margen de tipos y si los campos van numerados.
  La clave almacenada (`grid.documentViewMode`) no cambia, así que una
  elección existente sobrevive.
- **`connections.maxConnections` cambia de significado**: de "techo de un
  único pool" a "total para un servidor". No se publicó nada con el
  significado antiguo, así que no hace falta migración; el valor por defecto
  pasó de 5 a 10 en consecuencia, porque ahora cubre una conexión más sus
  vistas por base de datos en lugar de un solo pool. Una conexión de primer
  nivel pide como mucho 5 de esa asignación y deja sitio a propósito para una
  vista de base de datos, de modo que fijar un presupuesto ajustado en una
  conexión no puede volver imposible abrir sus propias bases de datos.

### Corregido

- **Una columna estrecha de la rejilla ya no esconde el nombre del campo en
  favor de su tipo.** La cabecera pone el nombre y el tipo de dato en una
  línea, y ambos eran elementos flex normales — pero solo el nombre podía
  encogerse, porque `truncate` es lo que permite a un elemento flex bajar de
  su ancho de contenido. Así que lo primero que tiraba una columna demasiado
  estrecha era justo la parte que la identifica: una columna `BOOLEAN` se
  quedaba en un escueto "BOOL", sin nada del nombre. Ahora la prioridad está
  invertida: primero se recorta el tipo, hasta desaparecer, y el nombre solo
  empieza a elidirse cuando ya no queda tipo.
- **El tooltip de la cabecera de columna describe el campo en vez de anunciar
  acciones de ordenación.** Ahora muestra el nombre completo (lo que recorta
  una columna estrecha), el tipo completo, la clave primaria/ajena con la
  `tabla.columna` referenciada, la nulabilidad cuando el catálogo la conoce y
  el estado de ordenación actual — y está traducido, cosa que nunca estuvo. El
  texto antiguo ofrecía "Ctrl/Cmd+clic para añadir una columna", que se leía
  como una oferta de _crear_ una columna: incorrecto, y alarmante en una
  ventana que además ejecuta DDL. La ordenación sigue siendo descubrible por
  la flecha de cada cabecera.
- **"Bases de datos a mostrar" ya no se filtra entre entornos.** El
  subconjunto se guardaba en la conexión, y una conexión es global: al
  restringir un servidor de pruebas compartido a la base de datos de un
  cliente desde un entorno de "Producción", también desaparecían el resto
  de bases en el entorno al que ese servidor pertenece de verdad. El
  selector ahora pregunta dónde se aplica la elección: **este entorno**
  (por defecto) la mantiene local, de modo que la misma conexión puede
  mostrar todas las réplicas en un entorno y una sola base en otro;
  **todos los entornos** la guarda en la conexión como hasta ahora, que es
  además el valor que viaja en la exportación/importación de perfiles y en
  los orígenes compartidos. Un entorno sin elección propia sigue a la de la
  conexión, así que nada cambia hasta que elijas otra cosa y los
  subconjuntos existentes siguen funcionando igual. Una conexión publicada
  por un origen compartido es de solo lectura, así que en ella solo se
  ofrece el ámbito local — antes no había forma de filtrar sus bases sin
  que la siguiente sincronización lo deshiciera. Las conexiones **no** se
  clonan por entorno a propósito: duplicaría credenciales y entradas del
  llavero y abriría un segundo pool contra el mismo servidor. Lo que se
  acota es la vista, no la conexión.
- **Los filtros del árbol de conexiones sobreviven con la reconexión
  automática desactivada.** Qué conexiones se muestran, qué filas están
  plegadas y los nuevos subconjuntos de bases por entorno se restauran al
  entrar en un entorno independientemente de la preferencia _Reconectar al
  arrancar_. Describen cómo se ve un entorno, no qué reabre; detrás de esa
  condición, entrar en un entorno con la reconexión desactivada dejaba en
  pantalla los filtros del entorno anterior.
- **`too many connections` en servidores compartidos.** La huella de
  conexiones de HuginnDB no tenía límite, era invisible y se multiplicaba
  entre procesos que no se coordinaban entre sí — lo que, en una base de datos
  que además servía a un origen de datos de JetBrains, al pool del backend de
  una aplicación y a uno o varios sidecars MCP, era con frecuencia la gota que
  colmaba el vaso. Había varias cosas mal a la vez:
  - Explorar un servidor multi-BD abría **un pool entero extra por base de
    datos**, cada uno con su propio techo independiente de cinco, y nada los
    cerraba nunca salvo desconectar la conexión padre. Un servidor con doce
    bases de datos eran ~65 conexiones de techo desde una sola ventana,
    mantenidas hasta cerrar la aplicación. Los pools por base de datos están
    ahora limitados a **2** conexiones, con un máximo de **8 vistas abiertas**
    por conexión (se cierra primero la que lleva más tiempo sin usarse) y se
    cierran automáticamente tras **5 minutos** sin uso. Se reabren de forma
    transparente al volver a usarlas, así que no se pierde nada salvo el
    viaje de ida y vuelta.
  - La búsqueda entre bases de datos del explorador de esquema lanzaba
    `openDatabaseView` contra **todas** las bases visibles a la vez — en un
    servidor de diecinueve bases, una sola pulsación eran diecinueve intentos
    de conexión simultáneos. Ahora ejecuta como mucho tres a la vez y vacía el
    resto como una cola.
  - El cliente de MongoDB no fijaba ningún límite de pool, heredando el valor
    por defecto del driver de **100 por host** — una divergencia de 20x
    respecto a los drivers SQL, por omisión. Ahora toma el mismo presupuesto
    que todo lo demás.
  - Los pools se desmontaban por `Drop` en vez de con un cierre esperado, así
    que una reconexión o un cambio de entorno podía mantener a la vez, de
    forma transitoria, la sesión saliente y la entrante. Desconectar (y
    cualquier otro camino de desmontaje) cierra ahora de forma ordenada, con
    un tiempo límite para que un servidor muerto no lo bloquee.
  - `min_connections` / `idle_timeout` / `max_lifetime` / `acquire_timeout`
    quedaban en los valores implícitos de `sqlx`. Ahora se fijan
    explícitamente, y el tiempo de inactividad se acortó a 5 minutos para que
    un pool sin tocar devuelva sus sockets.
  - "Probar conexión" abría un pool de cinco conexiones para ejecutar un solo
    `SELECT 1`. Ahora abre una, y la cierra.
- **El conector MCP nunca liberaba un pool** durante toda la vida de su
  proceso — que es lo que el cliente MCP lo mantenga, típicamente días. Ahora
  cierra los pools que lleven cinco minutos sin usarse y su techo por defecto
  es 2 en vez de heredar el 5 de la aplicación de escritorio.
- **`too many connections` se reconoce ahora como tal** en vez de aparecer
  como una cadena opaca del driver: Postgres `53300`/`53400`, MySQL
  `1040`/`1203`, el tiempo de espera del pool de MongoDB y el de adquisición
  de nuestro propio pool. El mensaje informa de cuántos pools está manteniendo
  el propio HuginnDB y señala que otros clientes de la máquina comparten el
  límite del servidor; la búsqueda en abanico se detiene en vez de volver a
  dispararse contra un servidor que ya la está rechazando, y ofrece liberar
  los pools inactivos y reintentar.
- **Editar una conexión reseteaba en silencio campos que el diálogo no
  muestra.** `save_profile` reemplaza el registro entero, y el diálogo lo
  reconstruía solo a partir del estado del formulario — así que guardar una
  conexión devolvía su política de escritura MCP a solo lectura y perdía su
  subconjunto de bases visibles. El diálogo conserva ahora los campos del
  perfil almacenado que no edita.
- El clasificador que aplica la política de escritura del conector MCP trataba
  dos sentencias T-SQL como lecturas: `SELECT … INTO <tabla>` (que crea una
  tabla) y `EXEC`/`EXECUTE` (que puede renombrar objetos o ejecutar DDL
  dinámico). Ahora ambas se clasifican como DDL, así que una conexión en nivel
  `read-only` o `data` las rechaza.
- La herramienta MCP `list_connections` derivaba el nombre del driver de una
  representación `Debug`, así que una conexión MongoDB se reportaba como
  `"mongo"` en lugar del `"mongodb"` que usa el resto de la aplicación.

### Limitaciones conocidas (SQL Server)

- El **editor de estructura es de solo lectura**: se muestran columnas, claves,
  índices y claves ajenas, pero aplicar cambios requiere un generador de DDL
  T-SQL que todavía no existe. Renombrar una tabla (`sp_rename`) y el **editor
  de vistas** no están disponibles por el mismo motivo.
- La **exportación/importación `.sql`** todavía no está disponible: necesita un
  codificador de literales T-SQL y gestión de `IDENTITY_INSERT`.
- No se ofrece autenticación integrada/SSPI (iniciar sesión con el usuario de
  Windows actual sin escribir credenciales) ni tokens de Entra ID.
- Una instancia nombrada no se puede combinar con un túnel SSH: el SQL Browser
  es un servicio UDP aparte que el túnel no reenvía. Tuneliza el puerto TCP
  propio de la instancia y deja el campo de instancia vacío.

## [1.12.1] — 2026-08-05

### Añadido

- **Actualización masiva** — actualiza todas las filas/documentos que
  coincidan con un filtro en una sola operación, para los cuatro drivers.
  Un nuevo botón "Actualización masiva…" en la barra de herramientas abre
  un diálogo que reutiliza el constructor de condiciones de filtro
  avanzado de la propia rejilla para la parte del `WHERE`, más un editor
  columna/campo → valor para la parte del `SET`; una previsualización con
  debounce muestra el `UPDATE ... SET ... WHERE ...` exacto (o el
  `db.<collection>.updateMany(...)` en MongoDB) y cuántas filas coinciden
  actualmente antes de ejecutar nada. Un filtro vacío se rechaza salvo
  confirmación explícita, para que una condición en blanco no pueda
  convertirse silenciosamente en una actualización de toda la tabla.
- **Los controles de exportación/importación se movieron a la barra de
  herramientas de la rejilla de datos.** La exportación/importación JSON
  por colección de MongoDB (antes solo accesible desde el menú de clic
  derecho del árbol de esquema) y sus nuevos equivalentes SQL viven ahora
  junto al botón "Insertar" de la rejilla: un desplegable "Exportar datos"
  ofrece "exportar toda la tabla/colección" o "exportar resultados de la
  consulta" (limitado al filtro avanzado actual de la rejilla, sin
  paginar); MongoDB añade además una entrada "Importar JSON…" en el mismo
  grupo. Una nueva fila inferior de la barra de herramientas aloja la
  paginación y el zoom de filas, separados de las acciones de datos de la
  cabecera.
- **"Exportar base de datos…" es ahora un diálogo propio**, accesible
  tanto desde el menú de clic derecho de una conexión (elige una o varias
  bases de datos y, por base de datos, qué tablas) como, en modo
  multi-BD, desde el menú de una base de datos concreta (fijado a esa
  única base de datos). Todo lo marcado se escribe en un único fichero
  `.sql` combinado, con un modo "Datos" que elige entre `INSERT`s planos o
  una forma de borrado-e-inserción que sobrevive a volver a ejecutar el
  volcado contra un destino que ya tiene datos. Sustituye a la antigua
  exportación de un clic, siempre de la base de datos completa.
- **"Importar .sql…" es ahora un diálogo de confirmación** en vez de un
  simple `confirm` nativo del navegador: muestra el número de sentencias
  por adelantado y, para una conexión multi-BD, permite elegir contra qué
  base de datos ejecutar el fichero (o ejecutarlo tal cual, para un
  fichero que ya referencia su propia base de datos vía `USE`/nombres
  cualificados).
- **Editor de estructura: selector de tipo categorizado.** El combo de
  tipo de columna ahora se agrupa por categoría (Enteros/Reales/
  Texto/Fecha y hora/Binario/Otro, un catálogo por driver) con un campo
  de longitud/precisión aparte, más las casillas unsigned/zerofill de
  MySQL — primera pasada de un rediseño más amplio, al estilo HeidiSQL,
  de la creación/edición de tablas.
- **Renombrar una tabla desde el editor de estructura** ahora funciona: el
  campo Nombre vuelve a ser editable en modo edición, y aplicar un
  renombrado actualiza el título de la pestaña abierta (y cualquier otra
  pestaña abierta de esa tabla) en vez de dejar mostrado el nombre
  antiguo. El diálogo de renombrado rápido del árbol de esquema recibió el
  mismo arreglo.

### Cambiado

- Las entradas de menú contextual "Exportar…"/"Importar…" por tabla
  (MongoDB) y por esquema (SQL) del árbol de esquema se eliminaron ahora
  que la barra de herramientas de la rejilla y los nuevos diálogos a
  nivel de conexión/base de datos cubren lo mismo — las entradas por
  esquema en particular estaban mal etiquetadas (exportaban la _base de
  datos completa_, no el esquema pulsado). La exportación/importación a
  nivel de conexión y de base de datos se mantienen en el árbol. El
  sufijo "(Beta)" de "Exportar base de datos…"/"Importar .sql…" ha
  desaparecido.
- La tabla de columnas del editor de estructura se rediseñó con el
  aspecto propio de la app (bordes y filas en cebra) en vez de una
  `<table>` desnuda de inputs planos, con un icono de llave marcando la
  clave primaria.
- Al arrastrar una pestaña de tabla/consulta para dividir el espacio de
  trabajo, ahora se distingue claramente entre "dividir en esta dirección"
  y "añadir como pestaña aquí" en vez de un único resaltado plano, y los
  paneles vecinos se ajustan a su nuevo tamaño con una transición suave en
  vez de saltar de golpe.

### Corregido

- El constructor de `ALTER` del editor de estructura (Postgres/MySQL/
  SQLite) nunca emitía un `RENAME TO` a nivel de tabla, aunque ya
  manejaba el renombrado de columnas; la ruta de reconstrucción
  destructiva de SQLite tenía el mismo bug especular en su fuente de
  `INSERT`/`DROP`. Ambos arreglados.
- El job de CI de `rustfmt` fallaba en todas las ejecuciones (no de forma
  intermitente) por una línea sin formatear que quedó de un commit
  anterior.

## [1.12.0] — 2026-08-03

### Añadido

- **Entornos** — un nuevo nivel por encima de las conexiones: un conjunto
  con nombre de conexiones con sus propias pestañas, disposición de
  paneles y reconexión, cambiable desde un selector en la barra superior
  (#109).
- **Orígenes compartidos** — sincroniza las conexiones (y contraseñas) de
  un entorno desde un fichero de configuración compartido, así que unirse
  a un equipo consiste en escribir una passphrase una vez en vez de
  configurar cada conexión a mano (#108).
- **Las conexiones viven ahora en el árbol de esquema**, como sus dos
  niveles superiores por encima de las carpetas; las acciones de una
  conexión se movieron a su menú de clic derecho (#107).
- **Un selector de espacio de trabajo** con pestañas y búsqueda
  (conexiones y entornos) sustituye al antiguo marcador de espacio vacío
  (#110).
- **Las pestañas de tabla recuerdan sus filtros, orden y búsqueda** al
  restaurar una sesión (#112).
- **Filtrar por las filas seleccionadas** — clic derecho sobre una columna
  con filas seleccionadas añade un filtro `IN`/`NOT IN` en servidor (#114).
- **Feedback de ejecución de consultas rediseñado**: un cronómetro en
  vivo, un reparto editor/resultados 75/25 por defecto y un historial con
  búsqueda y «ejecutar de nuevo» por entrada.
- **Neon**, un nuevo tema oscuro casi negro con una paleta de acentos neón
  propia.
- Las pestañas de tabla/consulta abiertas usan ahora el aspecto «isla» del
  resto de la app, con un distintivo de driver permanente por pestaña.
- Las columnas de la rejilla de datos ahora muestran un divisor visible, se
  dimensionan según su tipo (booleanos/números/fechas/UUID con un ancho
  sensato desde el principio) y se redimensionan con una previsualización
  en vivo real en vez de una guía estática.

### Cambiado

- «Ir al registro referenciado» pasa de Ctrl/Cmd+clic a Alt+clic,
  liberando ese acorde para la multiselección de filas (#113).
- La barra de estado global ya no duplica el contador de filas, el
  cronómetro ni el badge de solo lectura de la propia consulta.

### Corregido

- Varios errores al cambiar de entorno que podían perder las pestañas
  abiertas, el foco o la disposición dividida, o colapsar una división en
  un solo grupo de pestañas.
- Un `SELECT` precedido de un comentario se ejecutaba bien pero no
  mostraba filas.
- Ctrl/Cmd+clic ahora alterna la selección de filas de forma fiable,
  incluso en tablas sin clave primaria (#113).
- Los menús desplegables largos ahora hacen scroll en vez de recortarse
  (#111).
- Corregida la regresión de rendimiento en MySQL/Postgres de la
  separación del conteo de filas en la 1.11.0: el conteo ya no compite
  con la carga de datos por una conexión del pool.
- Los logos de driver y la muestra de tema ahora son sensibles al tema en
  vez de ir sobre una placa clara fija.

### Rendimiento

- Un clic en la rejilla de datos, y abrir una pestaña nueva junto a varias
  ya abiertas, dejaron de re-renderizar el resto de filas/pestañas — antes
  ambos escalaban con el total de filas/pestañas.

## [1.11.0] — 2026-07-24

### Añadido

- **Vista de lista para MongoDB.** Las pestañas de colección de una conexión
  `mongodb` ahora ofrecen un selector tabla/lista en la barra de
  herramientas (solo visible para ese driver — el resto siguen mostrándose
  siempre como tabla). El modo lista renderiza cada documento como una
  tarjeta con una línea `campo: valor` por columna de primer nivel en vez de
  una columna por campo, que era el problema real: un documento con muchos
  campos, o con un valor de objeto/array anidado, obligaba a hacer scroll
  horizontal constante en modo tabla y aplanaba el valor anidado en un JSON
  de una sola línea difícil de leer. El modo lista imprime los
  objetos/arrays anidados con sangría en vez de aplanarlos. Es
  deliberadamente de solo lectura en esta primera versión — sin edición
  inline de celdas, sin fila de borrador para insertar/duplicar —, ya que
  ambas necesitan la UI de fila editable de la tabla; "Copiar como JSON" y
  "Eliminar" por fila sí funcionan directamente desde la tarjeta, porque
  ninguna de las dos la necesita. El modo elegido es una preferencia global
  (`grid.documentViewMode` en `prefs.json`, también expuesta en Ajustes →
  Cuadrícula), no por colección — al mismo nivel que `rowHeight` o
  `bitDisplay` —, así que cambiarlo una vez aplica a todas las colecciones
  MongoDB que abras después.

- **Reconectar al iniciar.** Una nueva preferencia en General (activada por
  defecto) hace que la ventana principal se reconecte automáticamente, al
  arrancar, a las conexiones que estaban activas la última vez que se cerró
  — usando las credenciales ya guardadas en el llavero del sistema. Antes la
  app arrancaba desconectada y había que reconectar cada host a mano (y, por
  el bug de disposición descrito más abajo, en el _orden correcto_) para
  recuperar el espacio de trabajo. Las conexiones cuya contraseña no está
  guardada, o cuyo host es inalcanzable, se omiten sin bloquear el arranque;
  el interruptor permite desactivar la función por completo. El estado de
  arranque — qué conexiones estaban activas, cuál tenía el foco y qué
  pestaña estaba activa — se guarda al cerrar de forma ordenada y,
  oportunistamente, en cada conexión/desconexión, así que el espacio de
  trabajo vuelve tal como se dejó (misma conexión en foco, misma pestaña,
  misma disposición de paneles) sin importar el orden en que los pools se
  reabran, e incluso un cierre brusco deja algo que restaurar.

- **Canal de compilación canary.** Un nuevo canal de pre-lanzamiento opt-in
  permite dogfoodear un cambio contra perfiles de conexión reales de
  producción _antes_ de que se publique en un release estable — sin
  necesidad de un release completo. Una compilación canary (compilada con la
  nueva feature de Cargo `canary`, junto con
  `src-tauri/tauri.canary.conf.json`) se instala en paralelo con la app
  estable: tiene su propio identificador de bundle (`io.huginndb.canary`),
  nombre de producto ("HuginnDB Canary") y un feed de auto-actualización
  separado, y aísla todo su estado en disco en un directorio de
  configuración dedicado `HuginnDB-Canary`. Ese aislamiento permite que un
  canary ejecute con seguridad migraciones destructivas y de un solo sentido
  en disco sin tocar nunca `profiles.json` / `tab_state.json` / `prefs.json`
  de la instalación estable. El servicio de llavero del SO se comparte
  deliberadamente, así que el canary reutiliza las contraseñas que ya guardó
  la compilación estable en vez de forzar a reintroducirlas. Las
  compilaciones se generan mediante un workflow manual de GitHub Actions
  `canary` desde cualquier rama o commit y se publican en un único release
  `canary` rodante; ver `docs/CANARY.md`.

- **Indicador de sandbox para la compilación canary.** Como el canary
  comparte el bundle de UI (y el llavero del SO) con la app estable, una vez
  _dentro_ de la ventana las dos eran indistinguibles — fácil confundir el
  sandbox con la instalación real. La compilación canary ahora deja su
  identidad inconfundible: una cinta ámbar persistente "SANDBOX · HuginnDB
  Canary" fijada sobre la cabecera (mencionando el directorio de estado
  aislado), una insignia "CANARY" junto a la marca de la cabecera, un título
  de ventana del SO consciente del sabor de compilación ("HuginnDB Canary"
  en la barra de tareas / Alt-Tab, que el frontend antes sobrescribía de
  vuelta a "HuginnDB"), y un panel Acerca de que muestra el nombre de
  producto canary y sus rutas de estado reales `HuginnDB-Canary`. La
  compilación estable no cambia visualmente. Un nuevo comando
  `get_app_flavor` expone al frontend la feature de compilación `canary` en
  tiempo de compilación, ya que las dos compilaciones distribuyen un bundle
  JS idéntico.

### Cambiado

- **El conteo de filas ya no bloquea la aparición de las primeras, y un
  conteo de la tabla entera es ahora una estimación instantánea.** Abrir una
  tabla/colección solía calcular la página de datos _y_ un `COUNT(*)` exacto
  (`count_documents` en MongoDB) en un mismo viaje de ida y vuelta, sin
  devolver nada a la rejilla hasta que ambos terminaban. En una tabla de
  varios millones de filas el conteo dominaba, así que el primer pintado
  esperaba segundos por una consulta cuyas 100 filas ya estaban en la mano —
  justo el reporte «Compass se siente más rápido» del issue #77. El conteo es
  ahora una petición aparte (`count_table_rows`) disparada junto con la carga
  de datos: las filas se renderizan en cuanto vuelve el `SELECT`/`find`, y el
  rango de paginación rellena el total cuando llega el conteo (paginar sigue
  funcionando mientras tanto). Para un recorrido de la tabla entera (sin
  filtros, sin búsqueda) el total viene de las estadísticas O(1) del motor —
  `pg_class.reltuples` en Postgres, `information_schema.TABLE_ROWS` en MySQL,
  `estimatedDocumentCount` en MongoDB — y se muestra como un `~N` aproximado
  (con tooltip al pasar el ratón). Una tabla nunca analizada (o SQLite, que no
  tiene una estimación barata) cae a un conteo exacto. Cualquier filtro o
  búsqueda activo fuerza un conteo exacto del subconjunto que coincide, pero
  sigue corriendo fuera del camino crítico del render. La herramienta
  `browse_table` del `huginndb-mcp` sin interfaz no cambia (conserva el
  conteo exacto en línea).

- **La barra de herramientas de la pestaña de tabla se consolida en una sola
  barra (al estilo MongoDB Compass).** La barra superior de una pestaña de
  tabla/colección amontonaba antes cuatro asuntos distintos en su borde
  izquierdo — el botón de recargar, el botón de filtro avanzado, el selector
  tabla/lista de MongoDB y una caja de búsqueda apretada de ancho fijo
  (`w-56`) —, mientras una _segunda_ franja de estado inferior llevaba el zoom
  de fila y los controles de paginación. Peor aún, el total de filas se
  mostraba dos veces: «37 filas de 37» arriba a la derecha y «1–37 / 37» abajo
  a la derecha. Todo vive ahora en una sola barra:
  - **Izquierda (acciones):** refrescar · filtro avanzado · la caja de
    búsqueda — que es ahora el ancla visual, creciendo para llenar el ancho
    disponible (con tope, y un icono de lupa al principio) en vez del antiguo
    tamaño fijo estrecho — y el botón **Insertar** justo al lado, ya que
    insertar es la otra acción principal sobre el conjunto de filas.
  - **Derecha (visualización), fijada con `ml-auto`:** un único rango de
    paginación en formato humano (`1–100 de 19759`, sustituyendo al antiguo
    conteo duplicado y a la forma con barra) · botones anterior/siguiente
    página · el selector de tamaño de página · el par −/+ de zoom de fila
    (subido desde la franja inferior eliminada) · el selector de vista de
    MongoDB (solo Mongo) · el tiempo transcurrido.

  La franja de estado inferior desaparece por completo, dando a la rejilla
  más espacio vertical. Se conecta a través de un nuevo slot `toolbarTrailing`
  en `DataGrid` (a juego con el `toolbarLeading` ya existente) más una prop
  `showRowCount`: las pestañas de tabla pasan `false` porque el rango de
  paginación sustituye al conteo, mientras que las pestañas de resultado de
  consulta/vista — que no paginan — conservan el «N filas de M» incorporado
  como su único indicador de total. Ningún comportamiento de datos cambia;
  mismas acciones, mismos atajos de teclado, es puramente un pase de
  disposición/affordance.

- **La disposición del panel de trabajo ahora es de nivel de sesión, no por
  conexión.** La geometría de división/flotación del dockview interno (cómo
  se organizan las pestañas de tabla/consulta abiertas) se guardaba antes de
  forma redundante bajo _cada_ conexión en `tab_state.json`, aunque un único
  dockview interno aloja las pestañas de todas las conexiones a la vez. Al
  restaurar, ganaba la conexión a la que te conectaras primero — así que la
  disposición solo volvía si te reconectabas en un orden concreto. Ahora se
  guarda una sola vez en el nivel superior de `tab_state.json` y se restaura
  una única vez al arrancar, independientemente del orden de conexión. Las
  disposiciones por conexión existentes se migran automáticamente en la
  primera carga tras actualizar (la usada más recientemente se promueve a la
  disposición de sesión), así que nadie pierde su distribución.

- **«Sacar a ventana flotante» ahora abre una ventana del sistema operativo
  real e independiente.** La acción de una pestaña llamaba antes a
  `addFloatingGroup` de dockview, que solo separa el panel _dentro_ de los
  límites del propio espacio de trabajo interno — el panel flotante se podía
  arrastrar, pero nunca más allá de los bordes del panel de workspace del que
  salía, lo cual frustraba el propósito cuando lo que se quería era, por
  ejemplo, tener el editor de celda completamente fuera de la vista de la
  tabla. Ahora abre una `WebviewWindow` nativa y desnuda (`open_tab_window`,
  renderizada por la nueva raíz `DetachedTabWindow`) que aloja únicamente esa
  pestaña — sin barra lateral, sin otras pestañas, sin menús — y se puede
  mover a cualquier parte del escritorio como cualquier otra ventana. La
  pestaña se elimina del workspace de la ventana principal en el momento en
  que se saca, así que cerrar la ventana flotante es simplemente el cierre de
  la pestaña: no queda ningún estado que reconciliar de vuelta. Aplica a
  todos los tipos de pestaña (tabla, query, estructura, vista, seguridad).
  Igual que «Nueva ventana», estas ventanas son efímeras — no tocan
  `tab_state.json` ni se restauran entre reinicios.

### Corregido

- **Hacer doble clic sobre el texto de una celda a veces ya no entraba en
  modo edición.** Desde que llegó el icono de «expandir» (#78), una celda
  seleccionada también dibuja un borde `ring-2 ring-inset ring-brand` sobre
  el propio `<td>`, ocupando el borde/padding de la celda junto al valor.
  En el webview de Linux (WebKitGTK), hacer doble clic directamente sobre el
  texto del valor a veces no llegaba a disparar el evento nativo `dblclick`
  — una peculiaridad conocida de WebKitGTK por la que `user-select: none`
  (fijado en toda la tabla, ver la nota `select-none` en `DataGrid.tsx`)
  suprime `dblclick` específicamente cuando hay texto seleccionable bajo el
  puntero, mientras que hacer doble clic sobre el padding vacío de la celda
  (sin ningún carácter bajo el cursor, que es lo que hacía parecer que el
  truco era clicar «el borde») funcionaba sin problema. El manejador
  `onClick` del `<td>` ahora también comprueba el propio `detail` del
  evento `click` (el contador nativo de clics del SO, al que esa
  peculiaridad no afecta): un segundo clic (`e.detail >= 2`) entra
  directamente por `openCellEdit`, la misma ruta que ya usaba
  `onDoubleClick` — así que el modo edición ahora se abre de forma fiable
  sin importar en qué punto exacto de la celda caiga el doble clic.

- **Escribir en una edición inline de celda ya no mandaba el cursor al
  final del valor en cada pulsación.** El `useMemo` de `columns` en
  `DataGrid` incluía `inlineEdit` (además de `fkEditCell`/`selectedCell`)
  en su array de dependencias, así que cada pulsación de tecla —que
  actualiza `inlineEdit.value`— reconstruía todo el array `columns`,
  entregando a cada columna una función `cell` con una referencia nueva.
  `flexRender` de TanStack trata `columnDef.cell` como un _tipo_ de
  componente (`typeof Comp === "function"` → `React.createElement(Comp,
props)`), así que una referencia nueva en cada render se interpreta como
  un tipo de elemento distinto para cada celda de la rejilla — forzando un
  desmontaje y remontaje completo de todo el cuerpo de la tabla, incluido
  el `<input>` que estuviera en edición. Un input `autoFocus` recién
  montado siempre coloca el cursor al final, que es exactamente lo que
  hacía imposible mover el cursor a mitad del valor y seguir escribiendo
  sin tener que reescribirlo entero. `fkEditCell`/`inlineEdit`/
  `selectedCell` ahora se reflejan en un `useRef` que se actualiza en cada
  render en lugar de ser dependencias del memo; la función `cell` de cada
  columna lee los valores en vivo desde esa ref, así que su propia
  identidad — y el DOM montado debajo — se mantiene estable entre
  pulsaciones.

- **Las ventanas secundarias («Nueva ventana») ahora pueden reorganizar sus
  paneles.** Arrastrar un panel en una ventana abierta desde el menú
  Ventana siempre mostraba el cursor de «no permitido»: la ventana se
  creaba sin el `dragDropEnabled: false` de la ventana principal, así que
  el gestor de arrastrar-soltar a nivel de SO de Tauri seguía activo y se
  quedaba con los eventos HTML5 drag de los que depende dockview. El
  constructor de la ventana secundaria ahora desactiva ese gestor nativo,
  igual que la ventana principal.

## [1.10.0] — 2026-07-23

### Añadido

- **Las vistas ya se pueden crear, editar, renombrar y eliminar desde el
  explorador de esquema (#86).** Hasta ahora una vista aparecía en el árbol
  en modo solo lectura — su menú contextual solo ofrecía Abrir / Copiar
  nombre / Copiar SELECT / Refrescar, con toda acción DDL explícitamente
  bloqueada (`!isView` en `SchemaExplorer.tsx`), y el backend ni siquiera
  tenía una consulta para leer la definición de una vista (`pg_get_viewdef`
  / `information_schema.views` / `sqlite_master.sql` nunca se llamaban). La
  única forma de tocar una vista era escribir a mano `CREATE OR REPLACE
VIEW` en el editor de consultas — exactamente la experiencia de SQL en
  crudo al estilo HeidiSQL que el mantenedor quería evitar, sobre todo en
  vistas con varios JOIN donde es difícil saber qué columnas/filas produce
  realmente la definición solo leyendo el SQL. En vez de construir un
  constructor visual de consultas/joins completo (punto 9 del roadmap,
  explícitamente de baja prioridad), la nueva pestaña «Editar vista…»
  combina un editor Monaco a tamaño completo para el cuerpo de la vista —
  con el mismo autocompletado consciente del esquema que el editor de
  consultas — con una rejilla de «previsualización de resultados» en vivo
  y con debounce que ejecuta el borrador actual (envuelto en un `SELECT`
  externo con `LIMIT`) para que las columnas y filas reales que produce un
  JOIN sean visibles mientras se escribe, más un panel de DDL de solo
  lectura (mismo patrón que el editor de estructura de tabla) que muestra
  las sentencias exactas que ejecutará Aplicar. Cinco nuevos comandos de
  Tauri (`get_view_definition`, `preview_view_change`, `apply_view_change`,
  `rename_view`, `drop_view`) siguen la misma forma que los ya existentes
  `get_table_structure`/`preview_structure_change`/`apply_structure_change`.
  MongoDB queda excluido en esta versión, igual que la edición de
  estructura de tabla — sus «vistas» son colecciones de agregación de solo
  lectura con un modelo de edición fundamentalmente distinto
  (`collMod`/`createView`).

- **Un operador `between` en el Filtro avanzado, unificando el filtrado por
  rango en todos los drivers (#81).** El constructor de filtro avanzado ya
  ofrecía `contains`/`not_contains`/`starts_with`/`ends_with` de forma
  consistente en Postgres, MySQL, SQLite y MongoDB (verificado al investigar
  este issue — el `contains` de MySQL ya funcionaba vía la ruta compartida
  `CAST(col AS CHAR) LIKE`), pero no existía ningún operador para filtrar un
  rango inclusivo en una sola condición; el usuario tenía que apilar una fila
  `gt`/`gte` y otra `lt`/`lte`. `FilterOp::Between` es ahora una única
  variante compartida consumida por `build_filter_clause` (SQL: `col BETWEEN
? AND ?` / `BETWEEN $N AND $N+1`) y por `build_filter` de Mongo (`{ $gte,
$lte }`), respaldada por un nuevo campo `value2` en `ColumnFilter`
  (añadido tanto en el struct de Rust como en su espejo de TypeScript — un
  valor que serde descartaría en silencio si no, ver gotcha #14). El diálogo
  lo ofrece junto a `gt`/`gte`/`lt`/`lte` para columnas numéricas/de fecha y
  muestra un segundo input «hasta» al seleccionarlo.

- **Un clic ahora muestra un icono directo de «expandir» sobre la celda
  seleccionada, para ver su valor completo sin tener que hacer antes
  doble clic y entrar en modo edición (#78).** Antes la única forma de ver
  el contenido completo de una celda larga era hacer doble clic, lo que en
  una celda editable también entraba en modo edición inline — un efecto
  secundario no deseado cuando el usuario solo quería _leer_ el valor. La
  rama plana (sin edición) del renderizador de celdas de `DataGrid` ahora
  comprueba si la celda coincide con `selectedCell` (fijado con un clic
  simple, comparado por la misma identidad referencial
  `rowValues`/`row.original` que se usa en el resto de la rejilla — ver
  gotcha #7) y, si es así, dibuja un pequeño botón `Maximize2` junto al
  valor. Al pulsarlo llama al ya existente `openHeavyEditor`, sin cambios,
  así que ya respeta la preferencia `cellEditorMode` del usuario (modal vs.
  panel lateral acoplado) igual que el propio botón de expandir del editor
  inline y el botón de pantalla completa del panel de previsualización de
  celda. El icono aparece de forma uniforme en columnas de texto, FK y BIT,
  y en resultados de consulta de solo lectura — es puramente un visor de
  valores, nunca un editor, así que no hace falta excluir ningún tipo de
  columna.

- **Ctrl+C / Ctrl+V ahora funcionan sobre la celda seleccionada de la
  rejilla de datos (#79).** `handleGridKeyDown` ignoraba deliberadamente
  cualquier combinación con Ctrl/Cmd (para no interferir con el copiar/pegar
  nativo del navegador), lo que hacía que Ctrl+C sobre una celda no copiara
  nada, ya que un `<td>` no tiene selección de texto nativa que copiar.
  Ctrl+C y Ctrl+V ahora tienen un caso especial antes de ese bloqueo
  general: Ctrl+C copia el valor en crudo de la celda seleccionada con el
  ratón (recurriendo a la celda activa navegada con teclado si no se ha
  clicado ninguna) mediante el mismo helper `copyToClipboard` que ya usa el
  «Copiar» del menú contextual de clic derecho. Ctrl+V lee
  `navigator.clipboard` y siembra `inlineEdit` con el texto pegado en vez
  del valor actual de la celda — reutilizando exactamente el mismo flujo de
  confirmar/cancelar de `CellInput` que una edición normal por doble clic,
  así que Enter/blur guarda el valor pegado y Escape lo descarta. Las
  columnas FK y BIT no tienen un control de texto libre en el que pegar
  (usan un combobox / `<select>`), así que pegar es, por ahora, un no-op
  deliberado ahí; copiar sigue funcionando en todos los tipos de columna.

- **Los atajos de teclado ya se pueden personalizar desde Ajustes → Atajos
  (#75), desbloqueando la mitad «atajo de teclado» del #78.** El issue #78
  pedía una alternativa por atajo al icono de expandir añadido arriba, ya
  que el bajo contraste del icono hace fácil pasarlo por alto — pero eso se
  dejó explícitamente para el #75. Ahora hay seis acciones reasignables:
  `openSettings` (Ctrl/Cmd+,), `toggleCommandPalette` (Ctrl/Cmd+K),
  `toggleTabSwitcher` (Ctrl/Cmd+P), `refreshData` (F5 — Ctrl/Cmd+R se
  mantiene como alias permanente no reasignable, ya que suprimir la
  recarga nativa del WebView es una necesidad de seguridad, no una
  preferencia), `runQuery` (Ctrl+Enter), y el nuevo `expandSelectedCell`
  (por defecto `Espacio`, imitando el Quick Look de macOS — confirmado sin
  usar en `handleGridKeyDown` hasta ahora, así que llega sin colisión
  alguna). Los cambios persisten en `prefs.json` como un nuevo mapa
  `keybindings` (id de acción → combinación), siguiendo el mismo patrón ya
  usado por las preferencias `grid`/`editor`/`ui` — un mapa vacío es un
  estado totalmente válido, ya que la nueva tabla `ACTIONS` de
  `lib/keybindings.ts` en el frontend es la única fuente de verdad para los
  valores por defecto. El listener global `keydown` de `App.tsx` y el
  `handleGridKeyDown` de `DataGrid` ahora comparan contra el atajo activo
  mediante un helper compartido `matchesBinding` en vez de comprobaciones
  fijas de `e.key`/`e.ctrlKey` — lo que de paso corrige un bug latente
  donde `Ctrl+Shift+K` era indistinguible de un simple `Ctrl+K` (ninguna
  rama comprobaba `shiftKey`). El `editor.addCommand` de Monaco, usado para
  `runQuery`/`toggleCommandPalette`/`toggleTabSwitcher` dentro de los
  editores de SQL y de vista, resuelve una máscara de atajo fija una sola
  vez al registrarse, sin forma de volver a comprobar una combinación en
  vivo — así que esos tres pasaron a `editor.onKeyDown`
  (`registerEditorActionRedispatch` en el nuevo `lib/monacoKeybindings.ts`),
  que lee el atajo activo desde el store en cada pulsación. La UI de
  Ajustes (`ShortcutsSection`/nuevo `ShortcutRow`) sustituye el antiguo
  marcador de posición de solo lectura: al hacer clic en una fila entra en
  modo captura «pulsa una tecla…» (Escape siempre cancela en vez de
  convertirse en el atajo), una reasignación que choca con la combinación
  de otra acción se rechaza en el sitio en vez de intercambiar o
  desvincular nada en silencio, y cada fila más un botón «Restablecer
  todo» pueden volver al valor por defecto. `expandSelectedCell` reutiliza
  exactamente el mismo par `resolveTargetCell()`/`openHeavyEditor()` que ya
  llama el manejador de clic del icono de expandir, así que el icono y el
  atajo convergen en una única ruta de escalado. También se subió el
  contraste de ambos iconos de expandir (`DataGrid`/`CellInput`) de
  `text-muted-foreground/50` a `/80` para que el icono añadido en el #78
  no necesite hover para notarse.

### Corregido

- **Las columnas espaciales de MySQL (`POINT`, `MULTIPOINT`, …) se
  clasificaban erróneamente como numéricas en el Filtro avanzado**, porque
  la comprobación de subcadena `"int"` de `isNumericType` también coincide
  dentro de la palabra `"point"`. Esas columnas perdían
  `contains`/`starts_with`/`ends_with` y ganaban comparaciones `>`/`<` sin
  sentido. Encontrado al auditar la unificación de operadores para el #81;
  corregido excluyendo la subcadena `"point"` de la comprobación de
  `"int"`.

- **Las herramientas de escritura del conector MCP podían quedar forzadas
  a solo lectura para una base de datos MongoDB sobre la que tenían acceso
  explícito `data`/`full`.** Reportado por un usuario que recibía `has MCP
write policy "read-only"` en `update_cell` contra una conexión cuyo nivel
  en Ajustes → MCP era en realidad `data`. La comprobación de escritura
  (`Huginn::require_class`) verificaba la política contra el id de pool
  _resuelto_ de `resolve_mongo_target` en vez del id de perfil real. En una
  conexión Mongo multi-base de datos (con `database` de nivel superior
  vacío — el caso habitual, ya que HuginnDB no obliga a elegir una base de
  datos al conectar), una llamada de herramienta que nombra un
  `schema`/`database` se resuelve al id sintético por base de datos
  `<connection_id>::db::<name>` para poder dirigirse al pool correcto en
  vivo — pero ese id sintético nunca es una clave en `profiles.json`, así
  que la búsqueda de política fallaba en silencio y caía al valor por
  defecto `ReadOnly`, sin importar cómo estuviera configurada realmente la
  conexión. `run_query`, `insert_row`, `update_cell` y `delete_rows` ahora
  verifican contra `a.connection_id` (el id de perfil real) en vez del
  destino resuelto; el destino resuelto se sigue usando, como antes, para
  encontrar el pool correcto. Se añadió una prueba de regresión que
  reproduce el escenario exacto (una conexión Mongo con política `data` y
  sin base de datos por defecto, direccionada vía `schema`).

- **`updateMany`/`updateOne` rechazaban una actualización con pipeline de
  agregación (`db.coll.updateMany(filtro, [{ $set: {...} }])`)** con
  `argument 2 must be a document`, aun cuando el driver `mongodb`
  subyacente soporta actualizaciones estilo pipeline desde el servidor
  4.2. El parser al estilo mongosh (`db/mongo/shell.rs`) solo construía un
  `Document` plano para el argumento `update`. Ahora acepta ambas formas —
  un nuevo enum `UpdateSpec` (`Document` | `Pipeline`) que refleja
  `mongodb::options::UpdateModifications` — así que las actualizaciones
  con pipeline (por ejemplo, `$replaceAll`/`$toUpper`/valores de campo
  calculados que referencian otros campos) funcionan a través de
  `run_query` igual que en `mongosh`.

### Seguridad

- **Verificación manual de extremo a extremo de la política de escritura
  del conector MCP contra un conjunto real de perfiles, usando un cliente
  de IA real (Claude Code operando `huginndb-mcp`) en vez de una prueba
  unitaria.** Primero se llamó a `list_connections`, de solo lectura (sin
  tocar ningún estado): de cada conexión expuesta — incluidas bases de
  datos de producción y sandboxes reales de clientes — exactamente una (un
  servidor de pruebas interno de ITBacking) tenía `mcp_write: "data"`;
  todas las demás conexiones estaban en el valor por defecto seguro
  `read-only`, tal como garantiza `McpWritePolicy::default()`
  (`state.rs`) para cualquier perfil al que nunca se le subió el nivel
  explícitamente en Ajustes → MCP. Después se intentó una llamada
  `insert_row` contra esa única conexión con política `data`, sobre una
  tabla de configuración sin relación con datos de clientes (sin datos de
  cliente, sin claves foráneas) — el objetivo de menor riesgo disponible —
  como comprobación completa de ida y vuelta (insertar, verificar,
  actualizar, borrar, sin dejar residuo). La escritura nunca llegó a
  `Huginn::require_class`: la propia capa de permisos de herramientas de
  Claude Code (el cliente que conduce la sesión MCP, no código de este
  repositorio) interceptó la llamada y la retuvo pendiente de autorización
  explícita del usuario, aunque la política del lado del servidor la
  habría permitido. Esto confirma que las dos barreras son independientes
  y ambas están intactas — una política `mcp_write` permisiva por conexión
  es necesaria pero no suficiente; el propio aviso de aprobación de
  acciones del cliente de IA que llama es una segunda barrera separada, no
  una intercambiable/redundante. No hubo cambios de código; esto es una
  entrada de checklist de release, no una corrección.

## [1.9.1] — 2026-07-22

### Corregido

- **Ejecutar un único INSERT/UPDATE/DELETE no mostraba ningún resultado (#82).**
  La ruta de sentencia única del editor de consultas (`Ctrl+Enter`) enviaba un
  resultado DML sin columnas directamente a `DataGrid`, que no tiene nada que
  dibujar para ese caso — el panel de resultados simplemente parecía vacío, sin
  error ni recuento de filas. Solo la ruta de lote multi-sentencia mostraba un
  resumen de «filas afectadas». Ahora un resultado DML (sin columnas) muestra
  un pequeño aviso «N filas afectadas · Xms» en su lugar, en todos los drivers
  SQL — esto no era específico de MySQL, solo más probable de notar ahí.

- **Las herramientas de escritura del conector MCP podían hacer que nuevas
  sesiones cliente vieran cero herramientas (#83).** Las herramientas de modo
  escritura añadidas para `insert_row`, `update_cell` y `delete_rows`
  introdujeron formas de JSON-schema nunca usadas antes en la salida
  `tools/list` de este servidor: una estructura anidada elevada a `$defs`/`$ref`,
  y campos de valor de PK cuyo esquema por elemento era el booleano desnudo
  `true` (la representación de schemars para «cualquier valor JSON»). Ambas son
  JSON Schema válido, pero un cliente MCP cuya ingestión de `tools/list` asume
  que cada nodo de esquema es un objeto plano puede lanzar una excepción con
  ellas — y si esa ingestión envuelve toda la lista de herramientas en un único
  try/catch, un solo esquema mal formado para ese cliente descarta
  silenciosamente las 12 herramientas de la sesión, mientras que el propio log
  del servidor (que solo refleja lo que envió) parece perfectamente sano. Los
  esquemas de las tres herramientas ahora están en línea y restringidos a mano
  a `string | number | boolean | null`, con una prueba de regresión que
  verifica que ningún subesquema `$ref`/`$defs`/booleano desnudo vuelva a
  aparecer.

- **Expandir una base de datos con el mismo nombre bajo una conexión distinta
  podía filtrar los datos de la conexión anterior (#76).** El árbol de esquema
  multi-base de datos indexaba sus nodos `DatabaseRoot` solo por el nombre de
  la base de datos; como nada vuelve a montar ese árbol cuando cambia la
  conexión activa, React reutilizaba la misma instancia de componente — y su
  id de pool cacheado localmente — para dos conexiones distintas que ambas
  exponían una base de datos con el mismo nombre (por ejemplo, una base
  `shop` tanto en un perfil MySQL como en uno de MongoDB). El nodo de la
  segunda conexión seguía mostrando las tablas de la primera. El nodo ahora se
  indexa por conexión + nombre de base de datos juntos, así que cambiar de
  conexión siempre obtiene una instancia nueva.

- **La disposición de ventana/paneles y las ediciones de pestañas en curso
  podían perderse al cerrar (#80).** Ningún hook de cierre de ventana llegaba
  a volcar a disco el estado de pestañas/disposición con debounce, y un simple
  gesto de dividir/flotar/redimensionar no programaba un guardado en absoluto
  (solo lo hacía un cambio de pestaña o de esquema) — así que un cierre normal
  de ventana, no solo un cuelgue, podía perder los últimos ~600ms de cambios,
  incluida la geometría de paneles divididos configurada momentos antes.
  Cerrar la ventana principal ahora vuelca de forma síncrona el estado de
  pestañas de cada conexión activa primero, y los cambios de disposición
  programan un guardado igual que ya lo hacían los cambios de pestaña.

- **La actividad de MongoDB nunca llegaba a la consola.** Tanto explorar una
  colección (`fetch_table_data`) como ejecutar un lote multi-sentencia de
  mongosh (`execute_batch`) delegaban directamente en el módulo del driver
  de Mongo sin llegar a construir nunca una entrada de log — a diferencia de
  la ruta de sentencia única y de insertar/actualizar/eliminar, que ya
  registraban correctamente. Todos los demás drivers registraban cada
  lectura y escritura; MongoDB solo registraba escrituras emitidas de una en
  una. Ahora explorar una colección registra una línea reconstruida
  `db.<colección>.find(filtro).sort().skip().limit()` (no hay una sentencia
  literal que repetir, como sí la hay cuando el usuario la escribe a mano), y
  cada sentencia de un lote de mongosh se registra individualmente, igual
  que en la ruta de lote SQL.

- **El constructor de filtro avanzado devolvía silenciosamente cero
  resultados en MongoDB al filtrar un campo numérico (o booleano).** El chip
  «Filtrar por este valor» del menú contextual envía el valor de la celda ya
  tipado (por ejemplo, el número JS `183`), pero el campo de valor del
  diálogo de filtro avanzado es una casilla de texto plano — siempre enviaba
  el texto introducido como una cadena JSON. Postgres/MySQL/SQLite no lo
  notan: el tipo de un parámetro sin tipar se infiere de la columna con la
  que se compara, así que un texto `"183"` sigue coincidiendo con una
  columna `integer`. La igualdad de MongoDB, en cambio, es de tipo BSON
  exacto, y un `string` `"183"` nunca coincide con un `int32` 183
  almacenado — así que el mismo filtro que funcionaba desde el menú
  contextual devolvía cero filas desde el diálogo. El diálogo ahora convierte
  el valor introducido a número/booleano según el tipo de la columna antes
  de aplicar el filtro (los operadores de coincidencia de subcadena —
  contiene/empieza por/termina en — conservan el texto tal cual, ya que
  esos siempre son una coincidencia de texto/regex independientemente del
  tipo de columna).

## [1.9.0] — 2026-07-20

### Corregido

- **Los logs de la consola se filtraban entre ventanas (#50).** Con una segunda
  ventana abierta (acción «Nueva ventana»), la consola de cada ventana mostraba
  las entradas SQL y de conexión de todas las demás. El backend ya dirigía los
  eventos de log a la ventana de origen, pero el listener del frontend no estaba
  acotado, así que Tauri los entregaba a todas las ventanas. Ahora la consola de
  cada ventana muestra solo su propia actividad; los avisos realmente globales
  (como la caída de una conexión compartida) siguen llegando a todas.
- **Las columnas booleanas de MySQL mostraban `NULL` en vez de su valor (#68).**
  Una columna `TINYINT(1)` / `BOOL` / `BOOLEAN` la reporta el driver con el
  nombre de tipo `BOOLEAN`, que el decodificador de valores no reconocía como
  entero — así que cada celda booleana caía a una decodificación de texto no
  válida para la columna y colapsaba a `NULL`. Las columnas booleanas ahora
  muestran su valor almacenado (`0` / `1`), como cualquier otro entero.

### Añadido

- **Filtro avanzado por columna (#66).** Un nuevo botón de filtro en la barra
  de la cuadrícula abre un constructor donde añades condiciones por columna —
  columna → operador → valor — combinadas con AND y aplicadas en el servidor.
  Los operadores dependen del tipo: las columnas de texto ofrecen contiene /
  no contiene / empieza por / termina en, las numéricas y de fecha ofrecen
  comparaciones (>, ≥, <, ≤), y todas ofrecen igual / distinto / es nulo / no
  es nulo. Funciona en Postgres, MySQL, SQLite (`LIKE`/comparaciones SQL) y
  MongoDB (regex / `$gt`…`$lt`). El botón muestra un contador de condiciones
  activas.

- **Vaciar una tabla desde el explorador de esquema (#69).** Una nueva entrada
  «Vaciar tabla» en el menú contextual de una tabla (o colección de MongoDB)
  elimina todas las filas conservando la tabla y su estructura — útil para
  tablas usadas como log. Usa `TRUNCATE` en Postgres/MySQL, `DELETE FROM` en
  SQLite y `deleteMany({})` en MongoDB. Un diálogo de confirmación protege la
  acción e incluye una casilla «no volver a preguntar» respaldada por una
  preferencia dedicada `confirmEmptyTable`, para que silenciarla no debilite
  otras confirmaciones destructivas.

- **Modo escritura del conector MCP, con un modelo de permisos por conexión.**
  El conector headless `huginndb-mcp`, de solo lectura desde la 1.7.0, ya puede
  realizar escrituras — gobernadas por conexión, no por un único interruptor
  global. Cada conexión tiene un **nivel de escritura** configurado en Ajustes
  → MCP:
  - `read-only` (por defecto) — solo lecturas;
  - `data` — añade DML a nivel de fila (`INSERT`/`UPDATE`/`DELETE`) vía
    `run_query` y las nuevas herramientas `insert_row` / `update_cell` /
    `delete_rows`;
  - `full` — permite además DDL (`CREATE`/`DROP`/`ALTER`/…) vía `run_query`.

  El nivel se relee de `profiles.json` en cada intento de escritura, así que
  cambiarlo surte efecto sin reiniciar el cliente de IA. Como el sidecar es un
  proceso headless que no puede mostrar un prompt, la aprobación por acción la
  da el cliente MCP, y HuginnDB registra cada escritura (éxito o fallo) en
  `mcp-audit.log` junto a tus perfiles. Un `UPDATE`/`DELETE` sin `WHERE` sobre
  toda la tabla se rechaza de plano, y un nuevo flag `--read-only` fuerza todas
  las conexiones a solo lectura sin importar su nivel guardado. El antiguo flag
  `--allow-writes` queda obsoleto e inerte. Ver [`docs/MCP.es.md`](docs/MCP.es.md).

## [1.8.3] — 2026-07-16

### Añadido

- **Crear una colección de MongoDB desde el explorador (#61).** MongoDB crea
  la colección de forma implícita en la primera escritura, así que no había
  manera de materializar una colección vacía desde la interfaz — tenías que
  insertar un documento antes. Ahora hay una entrada "Nueva colección" en el
  menú contextual de la base de datos MongoDB (y un botón "+" en la barra de la
  base de datos, igual que el "Nueva base de datos" de Postgres/MySQL), que
  emite un comando `create` explícito mediante un nuevo comando de backend
  `create_collection`, de forma que la colección aparece en el árbol antes de
  que exista ningún documento, como en MongoDB Compass. El nombre se valida
  (no vacío, sin el prefijo reservado `system.`); los drivers no-Mongo se
  rechazan (crean tablas a través del editor de estructura).
- **Elegir qué bases de datos muestra una conexión, al estilo DataGrip
  (#64).** Una conexión multi-base listaba _todas_ las bases del servidor y
  precargaba sus tablas en segundo plano — ruidoso y lento en servidores con
  decenas de bases. Una nueva lista de selección (el botón de casillas en la
  cabecera del explorador multi-base) permite elegir el subconjunto con el que
  realmente trabajas; el explorador muestra solo esas. La elección se guarda
  por conexión (`visible_databases` en el perfil; `null` = mostrar todas, de
  modo que las bases nuevas siguen apareciendo). Aplica a Postgres/MySQL y a
  clústeres MongoDB por igual.
- **Importar y exportar colecciones de MongoDB como JSON (#65).** La
  exportación de base de datos completa (`.sql`) nunca soportó MongoDB. Ahora
  cada colección tiene "Exportar colección (JSON)…" / "Importar JSON…" en su
  menú contextual, usando **Extended JSON canónico de MongoDB**, de modo que
  `ObjectId`/`Date`/`Decimal128`/… conservan su tipo en el viaje de ida y
  vuelta (a diferencia de la forma de visualización que muestra la rejilla). La
  exportación transmite directamente desde el cursor al fichero; la importación
  acepta un array JSON, un único objeto, o JSON por líneas (el formato por
  defecto de mongoexport) e inserta el lote tras una confirmación destructiva.

### Cambiado

- **El título de la ventana del sistema ahora refleja la conexión y la tabla
  activas (#57, #59).** Cada ventana se titulaba con un "HuginnDB" fijo, lo que
  hacía imposible distinguir varias ventanas desde la barra de tareas / Alt-Tab.
  El título muestra ahora `<perfil> · <base>.<tabla> — HuginnDB` para la pestaña
  de tabla activa (cayendo a `<perfil> · <base>` en otras pestañas, y a
  "HuginnDB" a secas cuando no hay conexión), y las pestañas de tabla se
  etiquetan `base.tabla` en vez de solo el nombre de la tabla, así la base y la
  tabla se ven siempre juntas. Se ha quitado el breadcrumb redundante
  `esquema › tabla` que aparecía junto al filtro de la rejilla — el título de la
  pestaña ya lleva esa identidad. Las ventanas secundarias quedan cubiertas por
  la configuración de capacidades (`win-*`).
- **Conectar a un servidor con muchas bases es ahora instantáneo — el
  explorador ya no precachea las tablas de todas las bases al conectar.** El
  explorador multi-base precargaba en segundo plano la lista de tablas de
  _cada_ base justo tras conectar, así que una conexión con 19+ bases se quedaba
  un momento en "Cacheando esquema… n/m" antes de asentarse. Esa precarga solo
  era una optimización de búsqueda y ahora es redundante con el selector de
  bases visibles (#64) y el ámbito de base activa: las bases se cargan de forma
  perezosa al expandirlas, y la búsqueda entre bases sigue haciendo el fan-out
  bajo demanda la primera vez que buscas. Efecto neto: conectar es inmediato
  independientemente de cuántas bases tenga el servidor; el único coste es que
  la primera búsqueda entre bases tras conectar se sirve "en frío".

## [1.8.2] — 2026-07-15

### Añadido

- **El auto-actualizador ahora se pone al día con releases publicados
  mientras la app sigue abierta, en vez de comprobar solo al arrancar.**
  `checkOnLaunch` era el único disparador — una instancia que nadie cierra
  nunca (un equipo compartido, un puesto que no se reinicia) podía quedarse
  en la versión anterior indefinidamente por muchos releases que se
  publicaran, porque nunca faltaba publicar, faltaba que la app volviera a
  preguntar. Un nuevo `startPeriodicChecks` (`src/stores/update.ts`) repite
  la misma comprobación cada 4 horas mientras la app siga en ejecución, así
  que una instancia de larga duración acaba enterándose sola. Junto con
  esto, la descarga del instalador ahora empieza en silencio en cuanto se
  detecta una actualización (`startBackgroundDownload`), así que cuando
  alguien repara en el aviso, instalar es instantáneo en vez de esperar una
  descarga. Lo único que esto deliberadamente NO automatiza es el propio
  `install()` — el paso que sobrescribe archivos, mata a la fuerza el
  sidecar `huginndb-mcp` (gotcha #23) y puede pedir elevación a Windows —
  que solo se ejecuta tras un clic explícito en "Instalar" / "Reiniciar
  ahora", nunca sin supervisión. Un nuevo estado `readyToRestart` distingue
  "descargada, a un clic de terminar" de "todavía descargando" tanto en el
  banner superior como en Ajustes → Acerca de. Como instalar mata el
  sidecar de MCP, `installAndRelaunch` también comprueba si sigue en
  ejecución (un nuevo comando de Tauri `is_mcp_sidecar_running` — un
  `tasklist`/`pgrep` según plataforma, sin dependencia nueva) y, si es así,
  pide confirmación al usuario antes de cortar de golpe una conexión que un
  cliente de IA podría estar usando en ese momento.
- **Se documentan Cursor y Antigravity como clientes MCP, y se mejora la
  lista de conexiones de Ajustes → MCP.** `huginndb-mcp` es un servidor MCP
  estándar sobre stdio sin código específico por cliente, así que ya
  funcionaba con cualquier cliente compatible con la especificación —
  incluidos Cursor y el IDE Antigravity de Google — pero `docs/MCP.md` solo
  detallaba Claude Code, Claude Desktop y Codex, dejando a quienes usan otros
  IDEs agénticos adivinando la ubicación del archivo de configuración y el
  formato JSON. Se añaden secciones dedicadas para ambos: el
  `.cursor/mcp.json` (de proyecto) / `~/.cursor/mcp.json` (global) de Cursor,
  y el flujo de Antigravity desde la UI ("Manage MCP Servers → View raw
  config") — ambos documentados con la misma forma
  `mcpServers`/`command`/`args` que ya genera el panel de Ajustes → MCP de la
  app, así que el snippet JSON existente se pega tal cual. Por separado, la
  lista de conexiones en Ajustes → MCP ahora tiene un filtro por nombre y un
  botón "seleccionar todas / deseleccionar todas" (limitado a las filas
  filtradas en cada momento), más un contador en vivo de "n de m
  seleccionadas" — la lista plana de checkboxes no escalaba bien pasado un
  puñado de conexiones guardadas.
- **`docs/MCP.md` tiene ahora una traducción al español mantenida
  (`docs/MCP.es.md`).** El visor de documentación integrado (Ayuda →
  Documentación) incluía la guía de MCP solo en inglés, sin importar el
  idioma de la UI elegido por el usuario — inconsistente con el resto de la
  app, que ya distribuye cadenas en español completas y un
  `CHANGELOG.es.md`. `src/lib/docs.ts` mantiene ahora un mapa `bodies` por
  idioma en cada entrada de documento (el inglés siempre presente) y
  `getDocBody` recurre al inglés cuando falta una traducción, siguiendo el
  mismo patrón que `getReleases` en `lib/changelog.ts` — el mismo contrato de
  "inglés autoritativo, el español puede ir por detrás" que ya usa el
  changelog.

## [1.8.1] — 2026-07-15

### Corregido

- **Actualizar en Windows mientras un cliente MCP tenía abierto el sidecar
  `huginndb-mcp` podía fallar con un error de permisos que no era tal.** El
  instalador NSIS se mantiene en el modo de instalación por defecto de Tauri
  (`currentUser`, escribe bajo `%LOCALAPPDATA%`, sin necesitar elevación) y
  cierra correctamente `huginndb.exe` si está en ejecución antes de
  sobrescribirlo — pero no tenía forma de saber que `huginndb-mcp.exe`
  existe, ya que ese proceso lo arranca de forma independiente el cliente MCP
  externo que lo tenga configurado (Claude Desktop, Claude Code…), nunca la
  propia HuginnDB. Si un cliente lo mantenía abierto durante una actualización
  desde la app, Windows bloqueaba el archivo y la sobrescritura fallaba con
  `ERROR_SHARING_VIOLATION`, mostrado al usuario como un error genérico de
  acceso denegado aunque no faltaban permisos de administrador reales. Un
  nuevo hook de instalación `NSIS_HOOK_PREINSTALL`
  (`src-tauri/windows/hooks.nsi`) cierra ahora el sidecar por la fuerza antes
  de copiar ningún archivo; el cliente MCP simplemente lo vuelve a lanzar la
  próxima vez que lo necesite.
- **`huginndb-mcp` rechazaba conexiones SQLite y MongoDB sin contraseña con
  "no stored password for keychain account ...::".** El helper
  `resolve_password` de la app de escritorio ya sabe que SQLite nunca
  guarda contraseña (no hay nada que autenticar — es un archivo local) y que
  en MongoDB es opcional (puede venir embebida en el URI de conexión, o el
  servidor puede permitir acceso sin autenticación), devolviendo una cadena
  vacía en ambos casos. El `ensure_connected` del servidor MCP nunca
  reutilizaba ese helper — llamaba directamente a
  `keychain::require_password`, así que cualquier conexión SQLite o MongoDB
  con URI sin credenciales expuesta a un cliente MCP fallaba en cada llamada
  con un error de "credencial ausente" que no era real. Ahora usa el mismo
  `resolve_password` que la app de escritorio.

## [1.8.0] — 2026-07-14

### Corregido

- **El panel de Seguridad de MongoDB funciona en conexiones multi-base de
  datos.** El fix de 1.7.0 para #52 enseñó a `list_collections` a devolver una
  lista vacía a nivel de clúster en vez de dar error, pero `list_users`/
  `list_privileges` nunca se actualizaron igual — abrir la pestaña de
  Seguridad en una conexión MongoDB sin base preseleccionada seguía lanzando
  "no database selected". Ambas funciones ahora operan a nivel de clúster vía
  el comando `usersInfo` con `forAllDBs: true` contra la base `admin` cuando no
  hay base seleccionada (el mismo patrón a nivel de clúster que ya usaba el
  chequeo de salud de la conexión), manteniendo el comportamiento actual por
  base de datos en el resto de casos.
- **El `run_query` del MCP ya no rechaza cualquier consulta de MongoDB.** El
  filtro de solo-lectura reutilizaba el clasificador de palabras clave SQL
  (`select`/`with`/`show`/`explain`/`pragma`), que una sentencia mongosh como
  `db.coll.find({...})` nunca cumple — así que cualquier lectura de MongoDB
  enviada a través de la tool `run_query` de `huginndb-mcp` se rechazaba por
  defecto, y la única vía de escape era el flag global `--allow-writes` (que
  además desbloquea escrituras SQL reales en cualquier otra conexión
  expuesta). El editor de consultas de escritorio nunca tuvo este problema
  porque clasifica las sentencias Mongo con `MongoOp::is_read()` antes de que
  se ejecute el filtro genérico; `run_query` ahora hace lo mismo.
- **Las tools del MCP ya pueden apuntar a una base concreta en una conexión
  MongoDB multi-base.** `list_tables`, `describe_table`, `list_indexes` y
  `browse_table` aceptaban un parámetro `schema` que se ignoraba por completo
  para MongoDB — cualquier llamada sobre una conexión sin base seleccionada
  fallaba con "no database selected", sin ninguna forma de indicar qué base
  usar, y `run_query` no tenía forma de apuntar a una base para un
  `db.coll.find()` suelto. La app de escritorio resuelve el mismo problema
  abriendo un pool sintético por base cuando el usuario expande una base en
  el explorador de esquema; esa lógica no necesitaba `AppHandle`/`Window` de
  Tauri para empezar, así que ahora se comparte con el servidor MCP, que
  resuelve el mismo pool por base siempre que `schema` (o el nuevo parámetro
  `database` de `run_query`) indique una base sobre una conexión sin
  ninguna vinculada.
- **`limit`/`offset` de `browse_table` aceptan también un string numérico.**
  Algunos clientes MCP serializan los argumentos enteros como strings JSON
  pese al esquema anunciado; ambos campos ahora admiten tanto un número JSON
  como un string numérico en vez de rechazar la llamada directamente.

### Añadido

- **Tipos BSON reales por columna en los resultados de consulta/exploración de
  MongoDB.** `run_query`, `browse_table` y la grid de datos etiquetaban toda
  columna con el tipo genérico `"bson"`, aunque cada campo tiene un tipo BSON
  concreto. Las columnas ahora reportan el tipo real inferido a partir de los
  documentos/valores devueltos (`int`, `string`, `date`, `objectId`, …),
  cayendo a `"mixed"` cuando los valores no nulos de un campo discrepan de
  tipo dentro del mismo resultado — una respuesta honesta en vez de elegir uno
  en silencio. Esto también da a las herramientas de IA que usan el conector
  MCP una señal de tipo real en vez de ninguna.
- **Tamaño de colección en el explorador de MongoDB.** Las colecciones antes
  siempre mostraban un tamaño desconocido. Una sola agregación `$collStats` a
  nivel de base de datos ahora devuelve las estadísticas de almacenamiento de
  todas las colecciones en una sola llamada (en vez de un `collStats` por
  colección), de forma que el explorador puede mostrar un tamaño en disco
  igual que ya hacen los drivers SQL.

## [1.7.1] — 2026-07-14

### Añadido

- **`huginndb-mcp` ahora viene incluido en el instalador, y Preferencias tiene
  un panel de MCP.** Antes el conector solo era accesible clonando el repo y
  compilándolo uno mismo — ningún instalador empaquetado incluía el binario.
  Ahora es un sidecar de Tauri (`bundle.externalBin`), instalado junto al
  ejecutable principal, y el workflow de release lo compila y coloca
  automáticamente. **Preferencias → MCP** resuelve esa ruta, deja elegir qué
  conexiones guardadas exponer, y genera un snippet `claude mcp add`/JSON
  listo para pegar — sin tener que rebuscar rutas de instalación ni ids de
  conexión en `profiles.json` a mano. Ver [`docs/MCP.md`](docs/MCP.md).

## [1.7.0] — 2026-07-14

### Añadido

- **Conector MCP (`huginndb-mcp`).** Un servidor [Model Context
  Protocol](https://modelcontextprotocol.io) headless y de solo lectura que
  expone a herramientas de IA (Claude Code, Claude Desktop, Cursor, …) las bases
  de datos que HuginnDB ya conoce —perfiles de `profiles.json`, contraseñas del
  llavero del sistema— por stdio, para que el asistente inspeccione el esquema y
  los datos reales en lugar de adivinar. Es un proceso independiente de la app de
  escritorio, abre los pools de forma perezosa y es **opt-in por perfil**
  (`--connections <id>`): no expone nada hasta que lo nombras. Solo lectura por
  defecto (`run_query` rechaza SQL que no sea de lectura; sin herramientas de
  escritura), con un tope `--max-rows` (1000 por defecto). Diez herramientas:
  `list_connections`, `list_databases`, `list_tables`, `describe_table`,
  `list_indexes`, `run_query`, `browse_table`, `server_version`, `list_users`,
  `list_privileges`. Se compila tras una feature de cargo opcional `mcp`
  (`cargo build --features mcp --bin huginndb-mcp`), así que un
  `pnpm tauri:build` normal no se ve afectado. Consulta [`docs/MCP.md`](docs/MCP.md).

### Corregido

- **Las conexiones multi-base ahora muestran un nombre en la barra de título
  (#51).** La miga de pan central pintaba el catálogo de la conexión
  directamente, así que una conexión multi-base (sin una base preseleccionada)
  dejaba el segmento central vacío. Ahora recurre al nombre de la conexión
  cuando no hay una única base.
- **El editor lateral acoplado ya no conserva el valor de otra tabla (#49).**
  Abrir una celda en el editor lateral y cambiar a otra pestaña dejaba el valor
  antiguo en pantalla aunque estuvieras viendo una tabla distinta. El panel
  queda ahora ligado a la pestaña que abrió la celda: se limpia al cambiar de
  pestaña (salvo que el búfer tenga cambios sin guardar, que se conservan para
  que un cambio de pestaña nunca pierda tu trabajo).
- **La guía de redimensionado de columnas cae sobre el borde real (#46).** La
  guía en vivo se posicionaba con los anchos nominales de TanStack, pero la
  rejilla usa un diseño `table-fixed` a ancho completo que estira las columnas
  más allá de esos anchos cuando no llenan la vista, así que la guía se
  desplazaba a la izquierda del borde real (el error crecía por columna). Ahora
  mide la posición renderizada de la cabecera que se redimensiona.
- **Las conexiones MongoDB abren sin base preseleccionada (#52).** Abrir una
  conexión MongoDB en modo multi-base fallaba con un error del driver porque
  listar colecciones requería una base seleccionada, lo que dejaba en blanco
  todo el árbol. Listar colecciones a nivel de clúster ahora devuelve vacío
  (como ya hacen los drivers SQL), así que la lista de bases se renderiza y
  puedes expandir una base concreta como antes.
- **Las ventanas nuevas son independientes de la principal (#50).** «Nueva
  ventana» abría una ventana que adoptaba la conexión activa de la principal —
  aparecía conectada sin que el usuario abriera nada, contradiciendo la
  independencia por ventana introducida en 1.4.0. El conjunto de conexiones
  abiertas es ahora por ventana: una ventana muestra una conexión como activa
  solo cuando abre el pool ella misma. La configuración compartida (perfiles
  guardados y preferencias) sigue sincronizándose entre ventanas, y una
  conexión cerrada en una ventana se sigue limpiando en las demás que la
  tuvieran abierta.

### Cambiado

- **El instalador de Windows pasa de MSI (WiX v3) a NSIS.** El build de release
  empezó a fallar al empaquetar el `.msi` en los runners Windows de GitHub —
  WiX v3 está archivado y sin mantenimiento desde febrero de 2025, y su
  `light.exe` fallaba de forma sistemática incluso al arrancar en la flota de
  runners actual, sin importar la imagen del SO (Windows Server 2022 o 2025),
  con un fallo pelado sin más detalle. Tauri soporta oficialmente MSI → NSIS
  como ruta de actualización (no al revés), y el `tauri-cli` que ya usa el
  proyecto (2.11.1) incluye la detección de una instalación MSI previa por
  parte de NSIS. Las instalaciones existentes reciben un `-setup.exe` en vez
  de un `.msi`; la app instalada no cambia.
- **`huginndb-mcp` se traslada a su propio crate del workspace
  (`src-tauri/mcp-server/`).** El cambio a NSIS anterior destapó un segundo
  problema, distinto, del bundler: con más de un `[[bin]]` en un paquete,
  `tauri-bundler` intenta medir/empaquetar todos los binarios declarados sin
  importar el feature-gating, así que buscaba un artefacto de `huginndb-mcp`
  que un `pnpm tauri:build` normal nunca produce. Mover el shim (ya era muy
  fino) a un crate hermano lo saca por completo del `cargo metadata` de la
  app. Se compila con `cargo build -p huginndb-mcp --release` desde
  `src-tauri/` — ver [`docs/MCP.md`](docs/MCP.md).

## [1.6.1] — 2026-07-10

### Añadido

- **Gestor de conexiones con búsqueda, árbol y multiselección (#39, #43, #40).**
  El rail izquierdo del gestor era una lista plana de selección única que se
  volvía difícil de escanear y buscar en cuanto tenías más de unas pocas
  conexiones. Ahora:
  - incluye un **buscador** que filtra por nombre, host, base de datos, grupo o
    URI;
  - muestra las conexiones como un **árbol de carpetas** (agrupadas por el campo
    `group`) con cabeceras de grupo colapsables — una búsqueda activa las
    despliega para que las coincidencias siempre se vean;
  - permite **multiselección** (Ctrl/Cmd+clic para alternar, Mayús+clic para un
    rango, más checkboxes por fila al pasar el ratón) con un **borrado masivo**
    que siempre pide confirmación, independientemente de la preferencia
    "confirmar acciones destructivas".
- **Duplicar conexión (#38).** El gestor de conexiones incorpora una acción
  _Duplicar_ que clona el perfil seleccionado en un borrador nuevo con el nombre
  uniquificado ("… (copia)"), listo para ajustar y guardar. La contraseña no se
  copia a propósito — las credenciales se indexan por id de perfil en el
  keychain del SO y el clon recibe un id nuevo — así que un aviso recuerda
  reintroducirla antes de conectar.
- **Modo de despliegue de grupos configurable (#40).** Una nueva preferencia en
  General (`Grupos de conexiones`) controla cómo aparecen los grupos de carpetas
  en el menú Archivo y en el gestor de conexiones — _siempre desplegados_,
  _siempre plegados_ o _recordar por grupo_ (el comportamiento anterior). Los
  grupos del menú Archivo ahora también son colapsables, igual que el switcher
  de la barra de estado.
- **Logos de marca en el desplegable de driver.** El selector de driver del
  editor de conexiones ahora muestra el logo oficial de cada base de datos junto
  a su nombre (tanto en el control como en las opciones), reutilizando los
  `DriverBadge` ya empaquetados y usados en el resto de la app, en lugar de una
  lista de nombres a secas.
- **Guía en vivo al redimensionar columnas de la tabla (#42).** Arrastrar el
  borde de una columna ahora muestra una guía vertical de altura completa que
  sigue al cursor, para ver el ancho objetivo antes de soltar en vez de tener
  que orientarte con la columna vecina. El ancho se sigue aplicando al soltar
  (el comportamiento diferido y persistido por tabla de siempre).

### Corregido

- **El editor lateral acoplado ahora se cierra cuando se cierra su pestaña de
  origen.** El editor lateral (estilo JetBrains) vive fuera del subárbol de
  cualquier pestaña, así que abrir una celda en él y luego cerrar la pestaña de
  esa tabla lo dejaba colgado con un valor obsoleto, esperando un descarte
  manual. Ahora la celda registra la pestaña que la abrió y el panel se cierra
  solo cuando esa pestaña (o su conexión) desaparece.
- **El deshacer del editor de celdas ya no alcanza la celda editada
  anteriormente.** El editor lateral acoplado (y el modal) reutilizaban un único
  modelo de Monaco entre celdas, así que tras editar un registro, seleccionar la
  misma columna en otro registro y pulsar Ctrl+Z restauraba el valor del
  registro _anterior_. Ahora Monaco se remonta con una pila de deshacer vacía en
  cada carga de celda, de modo que el deshacer queda acotado a la sesión de
  edición actual; escribir dentro de una celda se sigue deshaciendo con
  normalidad.
- **El selector booleano de celdas BIT ya no se cierra al abrirlo (#44).** Al
  editar una columna BIT de un registro existente (con BIT mostrado como
  booleano) se abría el `<select>` nativo pero se cerraba en cuanto pulsabas una
  opción: el `onClick` de la celda devolvía el foco al contenedor con scroll,
  robándoselo al desplegable. Ahora la celda cede los clics a su propio editor
  inline mientras está activo.
- **Abrir una tabla ya no lanza COUNT + SELECT dos veces (#41).** Dos cosas
  duplicaban la carga inicial: el callback dependía de `searchColumns` (derivado
  de la lista de columnas que se carga de forma asíncrona, así que cambiaba de
  identidad y reejecutaba el efecto al llegar las columnas) y React StrictMode
  invoca los efectos dos veces en desarrollo. Ahora `searchColumns` se lee
  mediante una ref y la carga se deduplica en el envío — una petición idéntica
  ya en vuelo se descarta — así que abrir una tabla lanza exactamente un
  COUNT + SELECT, tanto en desarrollo como en producción.

## [1.6.0] — 2026-07-08

### Añadido

- **Interruptor legible de mostrar/ocultar en todos los campos de
  contraseña.** WebView2 dibuja un ojo nativo de revelar contraseña que no
  se puede tematizar y se renderiza casi negro — prácticamente invisible en
  superficies oscuras. Ahora está oculto en toda la app y sustituido por un
  interruptor `PasswordInput` tematizado (de apagado a color de primer
  plano al pasar el ratón, etiqueta bilingüe). Se aplica a todos los campos
  secretos: contraseña de conexión, contraseña/passphrase de SSH, las
  passphrases de exportación e importación, el prompt de contraseña al
  conectar y el token de GitHub del diálogo de feedback.

- **Renovación de la gestión de pestañas.** Con muchas pestañas abiertas era
  difícil saber qué tenías abierto o saltar a una tabla concreta. Cuatro
  novedades lo resuelven:
  - **Conmutador rápido de pestañas abiertas (Ctrl/Cmd+P).** Un overlay
    centrado en el teclado que lista las pestañas _actualmente abiertas_ en
    todas las conexiones, agrupadas primero las fijadas y luego por
    `conexión · base de datos`. Busca por nombre, navega con las flechas,
    Enter salta (y apunta el espacio de trabajo a la conexión de esa
    pestaña), y cada fila fija/desfija o cierra en línea (Suprimir cierra la
    resaltada). Distinto de la paleta de comandos (Ctrl+K), que abre cosas
    _nuevas_.
  - **Marcadores de tabla abierta en el árbol de esquema.** Toda tabla que
    está abierta en una pestaña muestra ahora un punto suave de marca en el
    árbol — no solo la activa — así que puedes ver de un vistazo qué tienes
    ya abierto mientras navegas.
  - **Botón conmutador en la barra de pestañas** con un contador en vivo de
    pestañas abiertas, que además sirve de acceso al desbordamiento cuando
    no caben todas.
  - **La pestaña activa siempre se desplaza a la vista.** Abrir una tabla
    cuando la barra ya estaba llena dejaba la nueva pestaña (activa)
    recortada detrás de los controles de desbordamiento ∨ / conmutador / "+"
    — dockview desplaza la pestaña activa a la vista, pero lo hace antes de
    que nuestro contenido de pestaña personalizado haya maquetado, así que
    la nueva pestaña quedaba oculta. La pestaña activa ahora se desplaza
    completamente a la vista en cuanto su contenido se pinta.
  - **Fijado + cierre masivo más completo.** Las pestañas se pueden fijar
    (⋮ / clic derecho, o desde el conmutador) para sobrevivir a «cerrar
    otras / todas / a la derecha»; las pestañas fijadas llevan un marcador
    de pin y se agrupan primero en el conmutador. Los menús de pestaña
    ganaron «Cerrar pestañas a la derecha» y «Cerrar otras en esta
    conexión». Los pines persisten por conexión entre reinicios.
- **Presentación de «Novedades» tras una actualización.** El primer arranque
  tras una actualización que sube la app a un release marcado `major` ahora
  muestra un diálogo curado e iconificado de puntos destacados (la
  contrapartida directa del changelog exhaustivo en Ajustes → Acerca de). El
  contenido es un catálogo empaquetado y redactado a mano en
  `src/lib/releaseNotes.ts` con copy bilingüe en i18n; el marcador de
  «visto» se persiste en `localStorage` (reflejando el store de
  actualizaciones) así que se dispara exactamente una vez por release
  `major`, solo en la ventana principal. Accesible en cualquier momento
  desde Ayuda → «Novedades». Al cortar un release `major`, añade su entrada
  (coincidiendo exactamente con la versión del manifiesto) y márcala como
  `major`.
- **Botón de ejecutar visible en el editor de consultas (renovación de
  UI/UX, fase 2).** La acción principal del editor no tenía ningún botón —
  era solo Ctrl+Enter y un CodeLens por sentencia, con un «Ejecutar todo»
  que aparecía condicionalmente. Un botón Ejecutar relleno con el color de
  marca ahora encabeza la barra de herramientas con un chip de atajo
  Ctrl/⌘+Enter, ejecuta todo el búfer (enrutando al ejecutor por lotes
  cuando contiene más de una sentencia) y muestra un spinner mientras se
  ejecuta. Guardar / historial quedan relegados detrás de un separador.
- **Rediseño del árbol de esquema (renovación de UI/UX, fase 1).** El árbol
  de base de datos/tabla de la izquierda ganó jerarquía y orientación claras.
  La tabla actualmente abierta se marca ahora en el árbol — un lavado suave
  de color de marca más un riel de marca de 2px con inset, controlado por la
  pestaña activa — así que siempre puedes ver «dónde estás». El nombre de la
  tabla es el elemento más destacado de su fila (primer plano / peso medio)
  frente a las etiquetas de sección y filas de columna, que son apagadas; los
  tipos de dato de columna están codificados por color (numérico ámbar /
  booleano verde / el resto apagado, reutilizando los tonos semánticos de la
  rejilla), y las columnas de una tabla cargan detrás de un esqueleto
  shimmer en vez de una línea en cursiva de «cargando…». La sangría de
  columnas sigue una escalera consistente de 12px por nivel (esquema →
  sección → tabla) con una línea continua de profundidad que baja desde el
  chevron de cada tabla abierta, y las insignias de métricas de tabla usan
  cifras tabulares. La confirmación de «base de datos creada» en modo
  single-database es ahora un toast tematizado en vez de un `alert()` nativo.
- **Navegación por teclado en la rejilla de datos (renovación de UI/UX, fase
  1).** La rejilla era solo de ratón, en contradicción con la identidad
  keyboard-first de la app. Las celdas ahora llevan una «celda activa»
  navegable por teclado marcada con un anillo `brand` con inset: las flechas
  la mueven, Inicio / Fin saltan a la primera / última columna de la fila,
  Enter abre el editor de celda (inline / combobox de FK / modal, mismo
  enrutado que el doble clic) y Escape la limpia. Hacer clic en una celda
  siembra la celda activa para que el teclado continúe desde ahí, y la celda
  activa se desplaza a la vista según se mueve (al instante — el indicador
  nunca anima, ya que sigue cada pulsación de tecla).
- **Casillas de selección de fila visibles en la rejilla de datos (renovación
  de UI/UX, fase 1).** La selección multi-fila ya funcionaba vía
  Ctrl/Cmd-clic y Mayús-clic, pero no había ninguna señal visible — el
  margen `#` solo mostraba el número de fila, así que la función era
  indescubrible. El margen ahora dibuja una casilla de seleccionar-todo de
  tres estados en la cabecera (marcada / indeterminada / vacía sobre las
  filas visibles) y una casilla por fila que aparece al pasar el ratón por
  la fila y se mantiene mientras la fila está seleccionada. Ambas se apoyan
  en el conjunto de selección existente indexado por PK (sobrevive a
  ordenar / filtrar / recargar) y se tiñen con el token `brand`; los números
  de fila ahora usan `tabular-nums`.
- **Exportar e importar bases de datos completas (#34), marcado Beta.** No
  había forma de sacar una base de datos de HuginnDB (o volver a meterla)
  salvo escribiendo un script a mano. «Exportar base de datos…» (menú
  contextual del explorador multi-base, o un botón de barra de herramientas
  en una conexión single-DB) vuelca esquema + datos a un único fichero `.sql`
  portable para Postgres, MySQL o SQLite. Postgres/MySQL escriben en tres
  fases — `CREATE TABLE` a secas, luego todos los datos, luego
  `ALTER TABLE ADD CONSTRAINT` (FK) + `CREATE INDEX` — así que un volcado de
  base de datos completa nunca necesita un orden topológico de dependencias
  entre tablas ni privilegios elevados (por ejemplo, el
  `session_replication_role` de Postgres, solo para superusuario). SQLite en
  cambio vuelca su catálogo tal cual desde `sqlite_master` (más fiel que
  reconstruir el DDL — conserva las restricciones `CHECK`, etc.) entre
  `PRAGMA foreign_keys=OFF/ON`. «Importar .sql…» elige un fichero y lo
  ejecuta a través del ejecutor de lotes de consultas _ya existente_ (la
  misma ruta `splitSql` + `execute_batch` que ya usa el editor de consultas)
  en vez de una segunda vía de ejecución, protegido tras la confirmación de
  acción destructiva. Marcado Beta en la UI — verificado hasta ahora solo
  por comprobación de tipos y `cargo check`, aún no probado de extremo a
  extremo contra un servidor real en los tres drivers.
- **Color de pestaña libre, y un estilo de acento seleccionable (#35).** El
  selector de color de pestaña solo ofrecía seis muestras fijas; ahora hay
  también un input de color nativo junto a ellas para cualquier valor hex.
  Por separado, el acento de la pestaña activa / color personalizado estaba
  fijado a una franja superior de 2px — una nueva preferencia en Ajustes →
  Rejilla → «Estilo de acento de pestaña» (`cap` / `rail` / `boxed`) lo
  cambia en su lugar a un riel izquierdo o un aspecto de superficie elevada,
  y un color de pestaña personalizado ahora sigue el borde que use el estilo
  elegido en vez de dibujarse siempre encima.

### Cambiado

- **Tooltips tematizados (renovación de UI/UX, fase 3).** Se añadió un
  wrapper de conveniencia `SimpleTooltip` sobre el primitivo Tooltip
  tematizado y se migró el chrome de la app fuera del `title=""` nativo para
  que sus tooltips combinen con el tema de la app en vez del predeterminado
  del SO: los botones de la cabecera (cambio de tema, preferencias), todas
  las señales de la barra de estado (paleta de comandos, historial de
  consultas, conmutadores de densidad y tema, el conmutador de conexiones) y
  las pestañas del espacio de trabajo (etiqueta, acciones ⋮, cerrar, nueva
  consulta +). Los disparadores de menú/contexto se envuelven en el propio
  trigger para que el tooltip se dispare al pasar el ratón mientras el menú
  sigue abriéndose al clic. El único caso que se deja deliberadamente en
  `title=""` nativo es un tooltip que vive _dentro_ de contenido de menú
  abierto (el reconectar/desconectar de las filas de conexión, las muestras
  de color de pestaña): un tooltip de Radix ahí choca con el propio manejo
  de hover/portal del menú, y un tooltip nativo del SO no lo hace.
- **Estado de conexión más claro (renovación de UI/UX, fase 3).** Una
  conexión perdida — posiblemente la señal operativa más importante — era
  un punto rojo de 6px más un icono rojo críptico. Las filas perdidas en el
  conmutador de conexiones de la barra de estado ahora reciben un lavado de
  fila destructivo y un botón «Reconectar» explícito y con etiqueta; los
  puntos indicadores de en-vivo/perdida son un poco más grandes, los
  botones de acción de fila tienen un área de clic real, y un intento de
  conexión fallido muestra un toast en vez de un `alert()` nativo. Las
  estadísticas de la barra de estado (número de filas, tiempo transcurrido,
  selección) suben sus números al primer plano con cifras tabulares.
- **Acciones de pestaña accesibles + peso de la pestaña activa (renovación
  de UI/UX, fase 3).** Los botones de cerrar (×) y acciones (⋮) de las
  pestañas del espacio de trabajo solo se revelaban al pasar el ratón,
  dejándolos inalcanzables por teclado; ahora también aparecen con el foco
  de teclado (focus-within / focus-visible). La etiqueta de la pestaña
  activa gana peso medio para combinar con la franja superior de marca +
  superficie elevada que ya lleva.
- **Marco de diálogo distintivo (renovación de UI/UX, fase 3).** Todo
  diálogo llevaba una `shadow-lg` plana con una entrada de solo fundido y un
  glifo de cerrar pelado y de baja opacidad. `DialogContent` ahora escala
  desde el centro (zoom, el movimiento correcto para un modal centrado),
  usa la escala de elevación compartida (`shadow-elevation-4`), y su botón
  de cerrar es un control con padding real y fondo al pasar el ratón en vez
  de una X sin área de clic al 70% de opacidad.
- **Control segmentado compartido + limpieza de consola/estructura
  (renovación de UI/UX, fase 2).** Un nuevo primitivo `Segmented` (radiogroup
  navegable por teclado con estilo de una sola tira de píldora con el
  segmento activo elevado) sustituye a las variantes hechas a mano: el
  conmutador de bug/feature del diálogo de feedback (dos botones completos) y
  las pestañas de sección del editor de estructura (botones planos sin
  ningún lenguaje de pestaña activa). El filtro de log de la consola ahora
  usa el `Input` compartido (tamaño pequeño) en vez de una caja de búsqueda
  hecha a mano, y sus casillas de tipo se tiñen con `accent-brand`.
- **Encuadre insignia del CellEditor (renovación de UI/UX, fase 2).** El
  editor de celda Monaco — la «función estrella» de la app — parecía un
  diálogo genérico. Ahora tiene un riel de cabecera con título: el nombre de
  columna, una insignia de tipo de contenido teñida con `brand`
  (JSON/XML/SQL/TEXT) y píldoras de recuento de caracteres/bytes, con los
  controles de panel/pantalla completa agrupados a la derecha. Ctrl/⌘+S y
  Ctrl/⌘+Enter guardan desde dentro del editor (vinculados vía Monaco para
  que no se traguen) con el atajo mostrado en el pie, la insignia de
  validez JSON es ahora un chip compacto con el mensaje del parser en su
  tooltip en vez de volcado en línea, y el frágil hack `mr-8` para esquivar
  el botón de cerrar se sustituye por padding de cabecera reservado.
- **Pulido de la paleta de comandos (renovación de UI/UX, fase 2).** La
  superficie insignia keyboard-first ganó las señales que le faltaban: una
  leyenda de pie persistente (↑↓ navegar · ↵ ejecutar · esc cerrar), un ↵ al
  final de la fila activa, un acento de borde izquierdo `brand` + icono
  teñido de marca en la fila activa, contadores de grupo en las cabeceras de
  sección, y un estado vacío iconificado. La fila resaltada ahora se
  desplaza a la vista durante la navegación con flechas (antes podía salirse
  de la pantalla), y un intento de conexión fallido muestra un toast en vez
  de un `alert()` nativo.
- **Chrome unificado del navegador de tablas (renovación de UI/UX, fase 1).**
  Una pestaña de tabla apilaba antes dos barras de herramientas casi
  idénticas. El breadcrumb de la barra superior (esquema › tabla) y el
  refrescar ahora se pliegan en la propia barra de herramientas de la
  rejilla de datos para que haya una sola barra, y la paginación + el zoom
  de fila pasan a una franja de estado de pie con cifras tabulares. La
  primera carga de una tabla muestra un esqueleto shimmer (con el
  breadcrumb) en vez de una línea pelada de «cargando…», y una recarga
  atenúa las filas obsoletas detrás de un spinner en vez de parecer
  congelada. El botón de confirmación de borrar fila ahora usa el estilo
  destructivo (rojo), igual que el diálogo de eliminar tabla.
- **Pulido de legibilidad de la rejilla de datos (renovación de UI/UX, fase
  1).** Las cabeceras de columna ahora muestran un glifo de orden
  persistente que se ilumina al pasar el ratón (era un icono casi invisible
  al 30% de opacidad), y toda la celda de cabecera gana un fondo al pasar
  el ratón para que la posibilidad de ordenar sea descubrible; el indicador
  de orden activo está alineado a la derecha y teñido con `brand`. Las
  lecturas numéricas — el número de filas, el rango de paginación y el
  tiempo transcurrido de la consulta — usan cifras tabulares para que dejen
  de cambiar de ancho al variar, los recuentos de fila/total se enfatizan
  en primer plano, y el tiempo transcurrido se vuelve ámbar y luego rojo
  solo cuando una consulta es lenta.
- **Acentos semánticos de dato tokenizados (`--pk` / `--fk` /
  `--numeric`).** Los iconos de llave de clave primaria/foránea y los
  valores numéricos de celda estaban fijados a `amber-400` / `sky-400` en
  la rejilla y el árbol de esquema, ignorando el tema activo. Ahora son
  tokens de tema (curados por cada tema integrado; más oscuros en temas
  claros para que los numéricos sigan siendo legibles en blanco) aplicados
  en DataGrid y SchemaExplorer. Se dejan fuera del editor de color de
  Apariencia por ser acentos de sistema de nicho.
- **Fundamento del sistema de diseño (renovación de UI/UX, fase 0).**
  Primera pasada de un rediseño de interfaz más amplio hacia un aspecto de
  herramienta de desarrollo moderna y densa. Sin funciones nuevas — esto es
  la base sobre la que se construye el resto de la renovación:
  - Dos nuevos tokens semánticos de tema, `--success` y `--warning`,
    distintos de `brand` (el único acento «en vivo / haz esto» de la app) y
    `destructive` (errores). Cada tema integrado fija sus propios valores
    curados y ambos son editables en Ajustes → Apariencia como cualquier
    otro color. Esto sustituye a los literales fijos `emerald-*` /
    `amber-*` / `blue-500` / `red-500` que estaban esparcidos por ~12
    componentes e ignoraban por completo el tema activo — así que los temas
    personalizados ahora recolorean las señales de estado de conexión,
    válido/inválido, advertencia y error. `applyTheme` también limpia
    cualquier token que un tema personalizado (preexistente) no defina, para
    que se aplique el valor por defecto de la hoja de estilos en vez de
    dejar un valor inline obsoleto del tema anteriormente activo.
  - Se unificó el indicador de «esta conexión está viva» en el token
    `brand`; antes se renderizaba esmeralda en el menú Archivo pero brand en
    el conmutador de la barra de estado para el mismo estado exacto.
  - Se añadió una escala de elevación (`shadow-elevation-1…4`, basada en
    `--foreground` para que se lea bien tanto en temas claros como oscuros)
    y una escala de micro-tipografía tokenizada (`text-2xs` / `text-3xs`,
    con un suelo de legibilidad de 10px) para sustituir los valores ad-hoc
    `text-[9px/10px/11px]`.
  - Anillo de foco de teclado más fuerte y consistente (`ring-2` + offset)
    en botones, inputs y selects, sustituyendo el anillo a ras casi invisible
    de 1px.
  - Las etiquetas de campo de formulario ahora usan por defecto
    `text-foreground` en vez de gris apagado, dando a todo diálogo una
    jerarquía real de etiqueta/valor.
  - `Input` ganó variantes de densidad (`inputSize` default/sm/xs) y un
    nuevo primitivo compartido `Textarea` sustituye a los campos multilínea
    hechos a mano en los diálogos de feedback y guardar consulta.
  - Se definió una pila de fuente sans-serif real para la UI (Inter primero,
    cayendo a la fuente de UI de la plataforma) en vez de depender del
    predeterminado pelado del sistema.

### Corregido

- **Los nombres de tabla largos ya no fuerzan scroll horizontal en el árbol
  de esquema (#33).** La etiqueta de nombre de tabla tenía `truncate` pero,
  como hijo flex sin `min-w-0`, nunca llegaba a encogerse por debajo del
  ancho de su contenido (los elementos flex por defecto tienen
  `min-width: auto`) — así que un nombre largo empujaba fuera la insignia
  de recuento de filas/tamaño y el árbol hacía scroll horizontal en vez de
  usar puntos suspensivos.
- **El menú de clic derecho de la pestaña ahora coincide con su menú ⋮
  (#36).** Los dos se mantenían a mano por separado y habían divergido: el
  clic derecho no tenía Dividir a la derecha/abajo, Flotar panel, ni las
  muestras de color que el menú ⋮ ya tenía. Ambos muestran ahora las mismas
  acciones en el mismo orden.

## [1.5.1] — 2026-07-07

### Añadido

- **Eliminar base de datos desde el explorador multi-base (#19).** El menú
  contextual del nodo de base de datos incorpora una acción destructiva
  "Eliminar base de datos…" (solo Postgres/MySQL), para poder borrar una base
  que hayas creado — antes el nodo solo ofrecía "Nueva query aquí" / "Seguridad"
  y una base recién creada quedaba atascada. Un nuevo comando de backend
  `drop_database` (validado con `validate_ident`) cierra el pool sintético por
  base de datos (esperando a `Pool::close`) antes de lanzar `DROP DATABASE`,
  para que Postgres no lo rechace por tener sesiones activas; al terminar, la UI
  cierra las pestañas y el esquema de esa base y refresca el árbol.
- **Agrupaciones de conexión como carpetas en el menú File (#20).** El menú File
  listaba todas las conexiones en plano, así que el `group` de un perfil no
  tenía efecto visible ahí. Ahora se agrupan: primero las sin grupo, luego una
  carpeta etiquetada por grupo (ordenadas) con sus conexiones indentadas debajo.
- **Combobox temático para el campo Grupo (#21).** El campo Grupo del editor de
  conexiones usaba un `<datalist>` nativo cuyo desplegable lo dibujaba el
  SO/webview e ignoraba el tema de la app. Ahora es un combobox temático (y sigue
  permitiendo crear: escribir un nombre nuevo crea un grupo nuevo) que filtra por
  subcadena los grupos existentes en un popover con el estilo de la app.
- **Colorear pestañas (#24).** Las pestañas abiertas se pueden colorear desde su
  menú ⋮ (seis colores predefinidos + limpiar); el color se muestra como una
  franja de 2px en el borde superior de la pestaña y se persiste por conexión.
- **Botón de refresco en el editor de estructura (#25).** La pestaña de
  estructura incorpora un botón para releer la definición actual de la tabla
  desde el servidor, y así traer cambios hechos en otro sitio con la pestaña
  abierta.
- **Ir arriba / ir abajo en la consola (#29).** Dos botones en la barra saltan
  al primer o último registro del log.
- **Conexión activa marcada en el desplegable de estado (#31).** La conexión en
  la que está enfocado el workspace ahora recibe un wash de marca + etiqueta
  "activa" en el desplegable de la barra de estado, distinta de las demás filas
  solo conectadas.

### Corregido

- **Los errores de conexión ya no se cortan en el borde del diálogo.** Un Test /
  Conectar fallido mostraba su mensaje de backend (a menudo largo) en una única
  línea con `truncate` en el pie del diálogo de conexiones, así que todo lo que
  excedía el ancho quedaba cortado con puntos suspensivos e ilegible — la
  mayoría de errores de driver son mucho más anchos que el pie. Los estados de
  error ahora usan una caja acotada, con salto de línea y scroll vertical
  (tintada en color destructivo, con icono de alerta) y un botón para copiar el
  mensaje completo; los estados cortos (probando / correcto / guardado) siguen
  en una sola línea.
- **La misma tabla en dos conexiones/bases ya no se muestra con pestañas
  idénticas (#22).** Las etiquetas de pestaña solo añadían el prefijo de conexión
  cuando había más de una conexión con pestañas abiertas, y el prefijo omitía la
  base de datos, así que la misma tabla abierta en dos conexiones (o dos bases
  con el mismo nombre) aparecía como un nombre indistinguible. Ahora las
  etiquetas incluyen el contexto `conexión · base` y lo muestran en cuanto otra
  pestaña abierta comparte el nombre base.
- **Un segundo lanzamiento por CLI ya no abre una tercera ventana (#23).** Con
  "abrir siempre en una ventana nueva" activado, lanzar de nuevo desde la CLI con
  una instancia ya en marcha producía tres ventanas. El enrutado del segundo
  lanzamiento se ejecutaba en todas las ventanas, así que la ventana creada para
  satisfacer la ruta "nueva ventana" volvía a drenar el buffer de intención
  compartido y lo enrutaba una segunda vez. Ahora el enrutado está limitado solo
  a la ventana principal.
- **Las tablas vacías muestran sus columnas y el botón de insertar (#27).** Una
  tabla sin filas no mostraba cabeceras ni forma de añadir la primera fila,
  porque las columnas se derivaban de la primera fila. `fetch_table_data` ahora
  recurre a la definición del catálogo cuando una página vuelve vacía.
- **Los errores al aplicar DDL se muestran (#26).** Un cambio de estructura que
  la base de datos rechaza — p. ej. una clave primaria que excede el máximo de
  bytes de MySQL — solo aparecía en el pequeño panel de vista previa DDL y
  parecía no hacer nada. Ahora también lanza un toast.
- **El campo de puerto se puede vaciar (#28).** Vaciar un campo de puerto
  numérico dejaba un `0` pegado que no se podía borrar. Ahora el `0` se muestra
  como campo vacío, restaurando el borrado/reescritura normal (los cuatro
  campos de puerto).
- **Sin selección de texto al seleccionar filas con Shift+Click (#30).**
  Seleccionar un rango de filas también arrastraba una selección de texto; el
  grid ahora es `select-none`.
- **Consistencia de los desplegables de conexión (#31).** El desplegable del
  menú File ya muestra los grupos de conexión (ver el cambio de agrupación
  arriba) y el desplegable de la barra de estado marca la conexión activa,
  resolviendo ambas partes del reporte.

## [1.5.0] — 2026-07-04

### Añadido

- **Crear base de datos.** Tanto la barra de herramientas del explorador
  multi-BD como la cabecera raíz de una conexión de una sola base de datos
  ganan un botón "+" (solo Postgres/MySQL — es DDL de nivel de servidor,
  oculto para SQLite/MongoDB) que abre un diálogo de nombre y ejecuta
  `CREATE DATABASE` mediante un nuevo comando de backend `create_database`,
  validado con la misma lista de permitidos `validate_ident` que usa el
  editor de estructura. La barra multi-BD refresca su lista de bases de
  datos al crear una; una conexión de una sola base de datos no tiene esa
  lista que mostrar, así que confirma con un mensaje en su lugar (un perfil
  limitado a una base de datos es al menos tan común como la navegación
  multi-BD — no hay razón para que sea el único modo que no puede crear una
  base de datos hermana en el mismo servidor).
- **Columnas redimensionables en la rejilla de datos.** `DataGrid.tsx`
  incorpora ahora la API de redimensionado de columnas de TanStack Table
  (tiradores en los bordes de columna, `columnResizeMode: "onEnd"` para que
  arrastrar no dispare un re-render por cada frame). Los anchos se
  persisten por tabla navegada (nuevo `grid.columnWidths` en `prefs.json`,
  indexado por `"<esquema>.<tabla>"` y luego por nombre de columna) — las
  rejillas de resultados de consultas ad-hoc redimensionan solo durante la
  sesión, ya que no tienen una identidad de tabla estable a la que
  asociarlo.
- **Agrupación de conexiones.** `ConnectionProfile` gana un campo `group`
  de texto libre (un solo grupo por conexión, sin registro de grupos
  aparte — se agrupan por igualdad simple de texto), editable desde un
  nuevo campo "Grupo" en el diálogo de conexión (con sugerencias de grupos
  ya existentes para evitar duplicados por error). El desplegable de
  conexiones de la barra de estado (`StatusConnections.tsx`) — el selector
  real que usa la app — agrupa ahora tanto las conexiones activas como las
  disponibles en cabeceras colapsables por grupo, dejando las conexiones
  sin grupo igual que antes, sin cabecera. El estado de colapsado se guarda
  por nombre de grupo en `prefs.json` (`ui.collapsedConnectionGroups`).
  Nuevo helper `bucketByGroup` en `src/lib/utils.ts`.

### Corregido

- **Conectar el mismo perfil desde una segunda ventana tiraba el pool en
  vivo de la primera ventana.** `ActiveConnections::insert` reemplaza
  incondicionalmente cualquier pool ya registrado para un id — correcto
  para reconectar un pool muerto, incorrecto para una segunda ventana
  llamando a `connect` sobre un perfil ya activo, lo que tiraba en silencio
  el pool (y cualquier túnel SSH) de la primera ventana. `connect` ahora
  comprueba `ActiveConnections::contains` primero y no hace nada (reutiliza
  el pool existente) en vez de caer al camino de reemplazo.
- **Ninguna ventana se enteraba de las conexiones, ediciones de perfil o
  cambios de preferencias hechos en otra ventana.** Cada ventana de Tauri
  comparte el mismo `AppState` de backend, pero cada frontend guardaba una
  copia privada de `active`/`profiles`/`prefs` tomada solo al arrancar, sin
  ningún puente de vuelta — peor que simple desactualización en el caso de
  las preferencias, ya que cada guardado envía el blob _entero_ (no un
  diff): dos ventanas cambiando ajustes distintos podían perder en silencio
  el que se guardara primero en cuanto se disparara el guardado con
  retardo de la otra. `connect`/`disconnect`/`save_profile`/
  `delete_profile`/`import_profiles`/`update_preferences` emiten ahora los
  eventos `connection-opened`/`-closed`/`profiles-changed`/`prefs-changed`;
  nuevos bridges de frontend (`connection-sync-bridge.ts`,
  `prefs-sync-bridge.ts`) los aplican en el store de cada ventana —
  `markConnected`/`markDisconnected` en `stores/connections.ts` (extraídos
  de `connect()`/`disconnect()` para que la ruta de sincronización y la
  ruta local compartan exactamente la misma limpieza, incluido el barrido
  de pestañas/esquema de las conexiones hijas sintéticas multi-BD) y
  `applyExternal` en `stores/preferences.ts` (adopta el snapshot recibido
  sin volver a disparar un guardado, así que no puede entrar en bucle ni
  volver a competir).
- **`insert_row`/`update_cell` de MySQL podían enlazar una columna `BIT`
  como texto plano cuando la metadata de caché de esquema del frontend aún
  no había cargado.** Ambos comandos decidían si envolver el placeholder de
  una columna `BIT` de MySQL en `CAST(? AS UNSIGNED)` según una pista
  `column_type` que envía el frontend junto al valor; cuando esa pista es
  `None` (caché de esquema vacía/desactualizada para la tabla en
  cuestión), el valor se enlazaba como una cadena de texto plano, que MySQL
  rechaza con `1406 (22001): Data too long for column` para cualquier cosa
  más ancha de un carácter (p. ej. `"true"`). Ambos comandos ahora recurren
  a una consulta de catálogo (`list_columns_inner`, el mismo helper que ya
  usa `fetch_fk_options`) cuando falta la pista, así que una columna `BIT`
  se detecta correctamente de cualquier forma. `insert_row` solo paga el
  viaje de ida y vuelta extra cuando al menos un valor realmente carece de
  pista de tipo.
- **Las entradas de log de la Consola y del ciclo de vida de la conexión se
  filtraban entre ventanas.** Cada ventana de Tauri (la principal, o
  cualquier "Ventana nueva" secundaria) montaba el mismo frontend y se
  suscribía de forma independiente al mismo evento de log del backend, que
  se emitía como broadcast a todo el proceso (`AppHandle::emit`) en vez de
  dirigido — así que una consulta ejecutada en una ventana aparecía también
  en la Consola de todas las demás ventanas abiertas, haciendo que una
  ventana secundaria pareciera una copia sin sentido de la principal en vez
  de una instancia independiente. `log_bus::emit` recibe ahora la etiqueta
  de la ventana de origen y entrega solo a esa ventana
  (`AppHandle::emit_to`); todos los comandos que producen una entrada de
  log SQL o de ciclo de vida de conexión (`execute_query`, `execute_batch`,
  `fetch_table_data`, `update_cell`, `delete_rows`, `insert_row`, `connect`,
  `disconnect`, `test_connection`, `open_database_view`) reciben ahora un
  parámetro `tauri::Window` (inyectado automáticamente por Tauri desde el
  webview invocante — sin cambios en el frontend) para suministrarla. La
  entrada de diagnóstico propia del keepalive en segundo plano no tiene una
  ventana de origen única (informa sobre una conexión que cualquier
  ventana puede estar navegando), así que sigue siendo broadcast vía una
  nueva `log_bus::broadcast`; el evento separado `connection-lost` que
  emite para la UX de reconexión ya era correcto como broadcast y no se ha
  tocado.

## [1.4.0] — 2026-07-02

### Añadido

- **Usuarios/permisos del servidor (panel "Seguridad").** Un nuevo botón
  "Security" junto al de refrescar del explorador de esquema (y, por base de
  datos, en el menú contextual del explorador multi-BD) abre una pestaña con
  los usuarios/roles que la conexión puede ver, con los privilegios
  cargándose bajo demanda al expandir cada fila. Implementado para **todos**
  los drivers, no solo un subconjunto: **PostgreSQL** (`pg_roles` +
  `pg_auth_members` para la pertenencia a roles, permisos sobre tablas vía
  `information_schema.role_table_grants`), **MySQL** (`mysql.user` +
  `mysql.role_edges` para los roles de MySQL 8, privilegios parseados desde
  `SHOW GRANTS FOR '<user>'@'<host>'` porque MySQL no tiene una vista de
  catálogo equivalente a la de Postgres), **MongoDB** (`usersInfo` sobre la
  base de datos resuelta, privilegios vía `usersInfo` con
  `showPrivileges: true`), y **SQLite**, que no tiene ningún concepto de
  usuarios/permisos y ahora muestra un estado vacío explícito ("este driver
  no tiene modelo de usuarios en el servidor") en vez de omitir la función en
  silencio. Una cuenta de MySQL sin `SELECT` sobre `mysql.user` degrada a
  mostrarse solo a sí misma (`CURRENT_USER()`) en vez de fallar todo el
  panel. Nuevos comandos de backend `list_users` / `list_privileges` en
  `src-tauri/src/commands/schema.rs` (despachados a
  `src-tauri/src/db/mongo/schema.rs` para MongoDB); nuevos DTOs `UserInfo` /
  `PrivilegeInfo` reflejados en `src/types.ts`; nuevo componente frontend
  `SecurityTab.tsx` (TanStack Table) y tipo de pestaña `security`.
- **Keepalive de conexión + reconexión tras pérdida de conexión.** HuginnDB
  no hacía nada proactivo para mantener una conexión viva — sin timeout de
  inactividad, sin heartbeat — dependiendo por completo del comportamiento
  por defecto de `sqlx` ("validar en el siguiente uso"), que no ayuda con un
  pool inactivo entre acciones del usuario ni con un túnel SSH caído. Cada
  conexión de nivel superior recibe ahora un ping en segundo plano cada 3
  minutos; un ping fallido marca la conexión como perdida, lo que pone en
  rojo su punto de estado tanto en la lista de conexiones como en el
  desplegable de conexiones de la barra de estado, y sustituye el botón de
  conectar/desconectar por uno de "reconectar" de un solo clic — se acabó
  descubrir una conexión muerta a mitad de una consulta con solo un error
  críptico del driver. Reconectar reutiliza el mismo id de conexión y
  mantiene intactas las pestañas abiertas y el estado del árbol de esquema,
  en vez de cerrarlo todo y empezar de cero. Limitado a las conexiones de
  perfil de nivel superior; los pools sintéticos por base de datos del modo
  multi-BD comparten la viveza de su conexión padre y no reciben un
  heartbeat propio. Nuevo módulo de backend `src-tauri/src/keepalive.rs`;
  nuevo frontend `stores/connectionHealth.ts` +
  `lib/connection-health-bridge.ts`.
- **F5 / Ctrl+R (Cmd+R en macOS) ahora refrescan dentro de la app en vez de
  recargar el WebView como si fuera una pestaña de navegador.** Con una
  pestaña de tabla activa, vuelve a ejecutar la consulta de esa pestaña
  (igual que pulsar su botón de recargar, respetando los filtros/orden/
  página actuales); si no, refresca el árbol de esquema (lista de bases de
  datos y tablas) de la conexión seleccionada — el mismo objetivo que el
  botón de refrescar del explorador, tanto en modo single-BD como multi-BD.
  Nuevo registro `src/lib/tableRefresh.ts` (con la misma forma "se registra
  al montar, se limpia al desmontar" que el registro de proveedores SQL de
  Monaco) que permite al manejador de teclas global en `App.tsx` llegar a la
  función de recarga de la pestaña de tabla activa sin pasar un callback a
  través del árbol de paneles de dockview.

### Cambiado

- **Los workspaces se sustituyen por ventanas nativas.** Los workspaces
  nunca fueron más que un sustituto de las instancias reales por ventana, y
  el diálogo "nuevo workspace vs actual" que aparecía al lanzar
  `huginndb …` por segunda vez nunca funcionó del todo bien. El selector de
  workspaces desaparece; **Ventana → Ventana nueva** abre ahora una ventana
  de sistema real y en blanco. Las ventanas secundarias son intencionalmente
  **efímeras** — nada de sus pestañas o su disposición sobrevive a un
  reinicio de la app, solo lo de la ventana principal. El fichero
  `tab_state.json` pasa a v3 (un mapa plano de `connections`); al
  actualizar, un blob v2 conserva solo las pestañas del workspace que
  estaba **activo** y descarta el resto — no hay fusión. El diálogo de
  segundo lanzamiento sigue preguntando "¿esta ventana o una nueva?" por
  defecto, pero ahora incluye un interruptor "No volver a preguntar" que
  recuerda la elección (`Preferencias → cliConnectDefault`).
- **Los menús de la barra superior pasan de 2 a 4.** Archivo y Vista habían
  acumulado acciones sin relación entre sí a medida que crecía la app.
  Archivo ahora solo gestiona conexiones (nueva/gestionar/importar/exportar,
  la lista de conexiones, desconectar todas); un nuevo menú **Ventana**
  incluye Ventana nueva y Restablecer disposición de ventanas; un nuevo
  menú **Ayuda** incluye Reportar/sugerir y Acerca de (antes solo en
  Archivo y solo accesible desde el icono de engranaje, respectivamente).
  Vista no cambia (visibilidad de paneles + métrica del árbol de esquema).

### Corregido

- **Una ventana nueva creada desde "Ventana → Ventana nueva" aparecía en
  blanco y Windows la marcaba como "No responde".**
  `WebviewWindowBuilder::build()` se bloquea en Windows cuando se llama
  desde un comando de Tauri síncrono — un problema documentado de
  WebView2. `open_new_window` es ahora una `async fn`, que es la solución
  que indica la propia documentación de Tauri.
- **Una conexión ad-hoc por CLI (`--host …`) sin `--password` nunca llegaba
  a conectar realmente**, incluso al elegir "esta ventana" en el diálogo de
  segundo lanzamiento — creaba en silencio un perfil desconectado y solo
  dejaba una pista en la Consola. Ahora siempre se intenta conectar (SQLite
  no tiene concepto de contraseña, y algunos servidores permiten
  autenticación sin contraseña/de confianza); un fallo de autenticación
  real sigue mostrándose igual que en una conexión de perfil guardado.

## [1.3.0] — 2026-07-01

### Añadido

- **Alternativa «No tengo cuenta de GitHub» en el reportador de
  incidencias.** Las dos rutas existentes (creación por API con un PAT
  guardado, o la página del navegador `issues/new` precargada sin uno)
  siguen aterrizando en GitHub, lo cual es un callejón sin salida para un
  usuario sin cuenta — la página del navegador solo muestra un muro de
  login. Un nuevo enlace en el pie del diálogo construye en su lugar una
  URL `mailto:` (con el mismo asunto y cuerpo prefijados por título/tipo,
  incluyendo el bloque de diagnóstico si está activado) y la abre mediante
  el plugin `opener`, delegando el envío en la app de correo por defecto
  del usuario — HuginnDB nunca toca SMTP ni guarda una credencial de envío
  de correo. La codificación por porcentaje está hecha a mano (el conjunto
  "unreserved" de RFC 3986) en vez de reutilizar `query_pairs_mut` de
  `url`, que es `application/x-www-form-urlencoded` y convertiría los
  espacios en caracteres `+` literales en el cuerpo — técnicamente
  inválido en una consulta `mailto:` y que varios clientes de correo
  muestran tal cual. El destinatario es la dirección `contact@shion.es`
  del proyecto, mantenida separada de los hermanos de GitHub de la ruta
  mailto para que un reporte perdido no se confunda con una divulgación de
  seguridad. Requiere ampliar la capacidad `opener:allow-open-url`, antes
  limitada solo a `github.com`, para permitir también `mailto:*`.

- **«Ir a la fila referenciada» en celdas de clave foránea (al estilo
  IDE).** En el navegador de datos, **Ctrl/Cmd+clic** sobre una celda cuya
  columna es una clave foránea de una sola columna ahora salta
  directamente al registro maestro referenciado — abriendo (o enfocando)
  la tabla padre pre-filtrada a ese valor, igual que «ir a la definición»
  en un editor. La misma acción está disponible desde el menú contextual
  de clic derecho de la celda («Ir a la fila referenciada»), y las celdas
  navegables por FK ganan un sutil subrayado al pasar el ratón. Reutiliza
  los metadatos de FK que ya devuelve `list_columns` (`referenced_schema`
  / `referenced_table` / `referenced_column`) — ninguna consulta nueva al
  backend. La tabla destino recibe el filtro a través de un nuevo
  `initialFilters` transitorio en la pestaña; volver a navegar a una tabla
  ya abierta lo vuelve a aplicar en vez de no hacer nada en silencio.
- **«Nueva consulta aquí» sobre una base de datos (explorador
  multi-base).** Hacer clic derecho sobre un nodo de base de datos en el
  explorador multi-base ahora ofrece _Nueva consulta aquí_, abriendo una
  pestaña de consulta ya limitada a esa base. Se ejecuta contra la misma
  conexión sintética por base de datos que usa el explorador, así que la
  consulta apunta a la base en la que se hizo clic sin tener antes que
  expandirla ni cambiar el ámbito activo.

### Corregido

- **El reportador de incidencias integrado ahora sí abre el navegador.**
  Enviar un reporte (o seguir el enlace «ver incidencia») dependía de
  `window.open`, que es un no-op dentro del WebView de Tauri — al hacer
  clic no pasaba nada. Abrir URLs ahora pasa por el plugin
  `tauri-plugin-opener` y aterriza en el navegador por defecto del
  sistema. La nueva capacidad está limitada a `github.com`, el único host
  al que enlaza el reportador. Añade la dependencia `tauri-plugin-opener`.
- **Un `INSERT`/`UPDATE` escrito a mano con valores `BIT`/enteros ya no da
  error en MySQL.** Las sentencias ad-hoc del editor SQL se enviaban por
  el protocolo preparado (binario), que rechaza o maneja mal una familia
  de sentencias que un cliente CLI ejecuta sin problema — los recurrentes
  errores de literal `BIT`/entero. El editor no vincula parámetros, así
  que no hay nada que preparar: las sentencias que no son `SELECT` ahora
  pasan por el protocolo de consulta simple **sin preparar**
  (`sqlx::raw_sql`) tanto en la ruta de sentencia única como en la de
  lote, así que lo que escribes se parsea exactamente igual que lo haría
  el propio cliente del servidor. La decodificación de `SELECT` no
  cambia.

## [1.2.0] — 2026-06-18

### Añadido

- **Consolidación en una sola ventana (instancia única).** Lanzar `huginndb` de
  nuevo con una ventana ya abierta ya no crea una segunda ventana. Se enfoca la
  ventana existente y —si el nuevo lanzamiento trae una conexión
  (`--connect-profile`, `--host …`, `--uri …`)— un diálogo pregunta si abrirla
  en un **workspace nuevo** o en el **actual**. Esto convierte el workspace en
  el verdadero contenedor de nivel superior: mantén, por ejemplo, una conexión
  MySQL de «configuración» y una MongoDB de «datos» a la vez en una sola ventana
  en lugar de dos instancias separadas tipo IDE. Un relanzamiento sin flags de
  conexión simplemente trae la ventana al frente. Implementado con
  `tauri-plugin-single-instance`; el argv del segundo lanzamiento se parsea con
  el mismo código que el arranque en frío y se reenvía por un nuevo evento
  `huginndb://cli-connect` (con búfer en el backend para sobrevivir a un
  lanzamiento que coincida con el arranque de la ventana).
- **Reporte de incidencias integrado.** Una nueva entrada _Reportar / sugerir_
  (menú Archivo, y una acción «Reportar este error» en las entradas con error de
  la Consola) abre un diálogo para crear un **bug** o una **sugerencia de
  feature** directamente en el tracker de GitHub. Con un Personal Access Token
  de GitHub configurado (guardado en el llavero del SO, nunca en disco) la
  incidencia se crea directamente vía la API REST y se enlaza de vuelta; sin él,
  se abre en el navegador una página `issues/new` pre-rellenada para enviarla a
  mano. Los reportes pueden incluir diagnósticos opcionales (versión de la app,
  SO/arquitectura), y la ruta «Reportar este error» pre-rellena el driver, la
  sentencia y el texto del error. Añade una dependencia `reqwest` (rustls) para
  la ruta de la API.
- **Ordenación multicolumna en la rejilla de datos.** Un clic normal en la
  cabecera de una columna ordena por ella (ciclo ASC → DESC → sin orden);
  **Ctrl/Cmd+clic** añade la columna como nivel de orden adicional de menor
  precedencia (ciclo ASC → DESC → eliminado en su sitio). Las cabeceras muestran
  ahora una flecha de dirección (↑/↓) en vez de solo resaltarse, más un pequeño
  número de nivel cuando participa más de una columna, de modo que la ordenación
  activa se lee de un vistazo en lugar de deducirse solo desde la consola. El
  comando `fetch_table_data` recibe ahora una lista ordenada `order` (en
  sustitución del par único `orderBy`/`orderDesc`) y construye
  `ORDER BY c1 …, c2 …` en los cuatro drivers (la ruta de MongoDB usa un
  documento de orden multiclave).
- **Iconos de clave primaria/ajena en las columnas de datos.** Las cabeceras de
  la rejilla muestran ahora un icono de llave —ámbar para una columna de clave
  primaria, azul cielo para una clave ajena de una sola columna— y el explorador
  de esquema gana la llave de clave ajena junto a la de clave primaria que ya
  existía. Replica los indicadores de clave a simple vista de HeidiSQL; usa
  metadata que `list_columns` ya devuelve, sin consultas extra.

### Rendimiento

- **Evitar el `COUNT(*)` redundante al ordenar o paginar.** El navegador de
  datos volvía a ejecutar `SELECT COUNT(*)` en cada fetch, incluso en cambios de
  solo orden/offset/página donde el total no puede haber cambiado. El frontend
  cachea ahora el total y solo lo recalcula cuando cambia el predicado de
  filtro/búsqueda (nuevo flag `with_count` en `fetch_table_data`), eliminando un
  viaje de ida y vuelta por cada interacción de orden/página —más notable en
  tablas grandes. La ruta de exploración de MongoDB omite `count_documents` de
  la misma forma. (Ordenar por una columna sin índice sigue siendo un orden
  completo del lado del servidor; eso depende de los índices de la tabla, no del
  cliente.)

### Cambiado

- **Confirmación de «Eliminar tabla» más simple.** Eliminar una tabla ya no
  exige escribir el nombre de la tabla para confirmar: ahora muestra un diálogo
  de confirmación destructiva normal (con un aviso de irreversibilidad) y una
  elección Cancelar / Eliminar, como esperan los usuarios de otros gestores de
  bases de datos. La acción sigue protegida tras una confirmación explícita;
  solo se quitó la fricción de teclear el nombre.

## [1.1.1] — 2026-06-15

### Añadido

- **Formulario de conexión de MongoDB (basado en campos).** El diálogo de
  conexión de MongoDB es ahora primordialmente un formulario, como Mongo
  Compass: campos discretos (host, puerto, base de datos, usuario, contraseña,
  **auth source**) construyen la cadena de conexión `mongodb://` en vivo,
  mostrada en modo solo lectura debajo. Un nuevo conmutador **Editar cadena de
  conexión** revela la URI cruda para editarla a mano —con un aviso ámbar de que
  las ediciones manuales pueden introducir errores— para los casos que el
  formulario no cubre (Atlas `mongodb+srv://`, conjuntos de réplica, opciones
  extra de URI). La contraseña nunca se incrusta en la cadena almacenada: sigue
  pasando por el llavero del SO. Editar un perfil guardado vuelve a poblar el
  formulario cuando su URI es representable, y se abre en modo de edición cruda
  en caso contrario.
- **`authSource` para MongoDB.** Un campo dedicado _Auth source_ (p.ej. `admin`)
  se añade a la cadena de conexión como `?authSource=…`, y un nuevo flag de CLI
  `--auth-source` cubre la ruta ad-hoc sin URI
  (`--host … --auth-source admin`). Antes la única forma de configurarlo era
  escribir la URI entera a mano, y la ruta de campos discretos lo omitía por
  completo — así que los inicios de sesión de MongoDB sin URI que necesitaban una
  base de datos de autenticación no predeterminada fallaban.
- **Filtro multi-tabla en el explorador de esquemas (estilo HeidiSQL).** El
  filtro de tablas acepta ahora varios patrones separados por `;` y coincide con
  una tabla cuando contiene **cualquiera** de ellos, así que `users; orders`
  muestra ambas a la vez. Funciona en exploradores tanto de una sola base de
  datos como multi-base-de-datos.

### Corregido

- **El panel de detalle de la Consola se puede cerrar sin vaciar la consola.**
  Hacer clic en una entrada de log abría su vista de detalle sin forma de volver
  a la lista completa salvo vaciar la consola; un botón de **cerrar** (y la tecla
  `Esc`) descartan ahora el detalle y devuelven a la lista de entradas.

## [1.1.0]

### Añadido

- **Driver de MongoDB (MVP).** HuginnDB se conecta ahora a MongoDB junto a los
  motores SQL. Conecta con una cadena de conexión (`mongodb://…` o Atlas
  `mongodb+srv://…`, la entrada principal — cubre conjuntos de réplica,
  `authSource` y opciones de URI), navega por bases de datos → colecciones en el
  explorador, e inspecciona documentos en la rejilla de datos (los campos de
  nivel superior se convierten en columnas, `_id` primero; los documentos/arrays
  anidados se renderizan como JSON y se expanden en la previsualización de celda).
  - **Editor de consultas estilo `mongosh`.** Ejecuta `db.coll.find({…})`,
    `.aggregate([…])`, `.countDocuments(…)`, `.distinct(…)` y los métodos de
    escritura (`insertOne`/`insertMany`, `updateOne`/`updateMany`, `replaceOne`,
    `deleteOne`/`deleteMany`), con `.sort()/.limit()/.skip()/.projection()`
    encadenados en `find`. Se admiten JSON relajado (claves sin comillas, comillas
    simples) y los constructores BSON comunes (`ObjectId(...)`, `ISODate(...)`,
    `NumberLong/Int/Decimal(...)`).
  - **Edición por `_id`.** Las ediciones de celda en línea, las inserciones de
    fila y los borrados se mapean a `updateOne`/`insertOne`/`deleteMany`
    indexados por `_id`. El tipo BSON inferido del campo guía la coerción de
    valor, de modo que un campo `Date`/`Long`/`Int` no se degrada silenciosamente
    a cadena.
  - **Estructura de solo lectura.** La vista de estructura muestra los campos
    inferidos de una colección y sus índices reales; se admite eliminar la
    colección desde el explorador. La edición de índices/validadores, las
    transacciones y la transferencia de perfiles para MongoDB quedan diferidas —
    véase `docs/MONGODB_ROADMAP.md`.
  - **Túnel SSH** disponible para conexiones `mongodb://` de un solo host; está
    deshabilitado para `mongodb+srv://` (un registro SRV resuelve a varios hosts,
    que el túnel de un solo puerto no puede representar).
  - **CLI:** `--driver mongodb` funciona con los flags discretos
    `--host`/`--port`, y un nuevo flag `--uri` / `--connection-string` acepta una
    URI `mongodb://` o `mongodb+srv://` completa (la única forma de alcanzar
    Atlas desde la CLI). Una cadena de conexión implica el driver de MongoDB
    cuando se omite `--driver`, y MongoDB se ofrece ahora en el selector de driver
    ad-hoc.
- **Cerrar pestañas en bloque desde el menú de pestañas.** Hacer clic derecho en
  una pestaña del espacio de trabajo (o el menú `⋮` de la pestaña) ofrece ahora
  **Cerrar otras pestañas** y **Cerrar todas las pestañas** además de **Cerrar
  pestaña**, de modo que un espacio de trabajo lleno de tablas/consultas abiertas
  se puede limpiar en una sola acción en vez de cerrar cada pestaña
  individualmente.

### Corregido

- **Filtrar el explorador de esquemas ya no falla en conexiones sin estadísticas
  de tabla.** `list_tables` serializaba las estadísticas ausentes de recuento de
  filas / tamaño como JSON `null`; el badge de métrica del explorador solo se
  protegía contra `undefined`, así que un `null` llegaba a `formatBytes` y lanzaba
  _"Cannot read properties of null (reading 'toFixed')"_ — tumbando todo el
  panel. Esto afectaba a las conexiones CLI/ad-hoc y a builds de SQLite sin
  `dbstat`, y aparecía al filtrar porque el filtro fuerza la expansión de todas
  las secciones (renderizando badges que antes estaban colapsados). El backend
  omite ahora las estadísticas ausentes (acorde al contrato `?: number` del
  frontend) y el badge se protege con `!= null`; `formatBytes`/`formatCount`
  además abortan ante entradas no finitas.
- **Abrir o cerrar el editor de celda lateral ya no reinicia la división Esquema /
  Espacio de trabajo.** El editor lateral se acopla como hermano en la fila
  `[Esquema | Espacio de trabajo | Celda]`, y dockview redistribuye el espacio
  liberado/ocupado proporcionalmente entre _todos_ los hermanos cuando se añade o
  elimina un hijo — redimensionando silenciosamente el panel de Esquema cada vez.
  El ancho de Esquema se recuerda ahora mientras el editor lateral está ausente y
  se vuelve a imponer en cada apertura/cierre, de modo que solo el panel de
  Espacio de trabajo absorbe el cambio.
- **Duplicar una fila de MySQL con una columna `BIT` y luego guardar podía fallar
  con "Data too long for column".** El control 0/1 mostraba el valor normalizado
  pero dejaba la celda borrador con el valor crudo duplicado; si ese valor no era
  ya exactamente `"0"`/`"1"` (p.ej. un `"true"` duplicado, o una celda `BIT(1)`
  heredada que arrastraba un entero más ancho/basura), el valor crudo era lo que
  se confirmaba, y `CAST(? AS UNSIGNED)` a `BIT(1)` desbordaba. El control
  sincroniza ahora la celda confirmada con el `0`/`1` mostrado al montarse.

## [1.0.10] — 2026-06-11

### Añadido

- **Ejecutar un buffer entero de sentencias de una vez.** Pulsar `Ctrl+Enter` (o
  el nuevo botón "Run all (N)") en un editor que contiene varias sentencias
  delimitadas por `;` —p.ej. un lote de INSERTs copiado de la rejilla— las
  ejecuta ahora en orden sobre una única conexión y muestra un resumen por
  sentencia, con las filas del último SELECT en la rejilla. Antes el buffer
  entero se enviaba como una sola sentencia preparada, que el driver rechazaba
  ("cannot insert multiple commands into a prepared statement"). Ejecutarlas
  sobre una sola conexión también significa que un `BEGIN`/`COMMIT` explícito (o
  `USE` de MySQL) se arrastra ahora a través del lote. El CodeLens "▶ Run" por
  sentencia sigue ejecutando una sola sentencia.
- **Selector de base de datos en el editor de consultas.** En un servidor
  multi-base-de-datos (Postgres / MySQL) la pestaña de consulta tiene ahora un
  desplegable de base de datos: elige una base de datos y la consulta se ejecuta
  contra ella — y el autocompletado cambia a sus tablas — sin escribir `USE`/un
  prefijo de esquema en el SQL. Respaldado por los pools hijos por base de datos
  ya existentes. SQLite (archivo único) no muestra selector.
- **Previsualizaciones de tema y editor en Preferencias.** Apariencia muestra una
  pequeña maqueta del armazón de la app más muestras de color pintadas con el
  tema seleccionado; Editor muestra un fragmento SQL de ejemplo renderizado con
  la fuente, el tamaño, el ajuste de línea y los colores del tema de Monaco
  elegidos.
- **Conmutador de pantalla completa en el editor de celda lateral**, igual que el
  editor modal (`F11` / `Esc`, o el botón de cabecera).
- **Control dedicado 0/1 para columnas `BIT`** en la fila borrador de inserción y
  la edición de celda en línea (MySQL). Emite el valor numérico que la columna
  espera y etiqueta las opciones según la preferencia de visualización de BIT de
  la rejilla, en vez de un campo de texto que parecía pedir un booleano.

### Cambiado

- **Las conexiones abiertas desde la CLI son ahora temporales.** Una conexión
  ad-hoc lanzada con `--host …` se mantiene en memoria durante la sesión (de modo
  que el explorador y las pestañas funcionan con normalidad, marcada como "temp")
  pero ya no se escribe en `profiles.json`, así que no se acumula entre lanzamientos.
  Los perfiles creados en la app siguen persistiendo como antes.
- **Las tarjetas de badge de driver son conscientes del tema** — los logos de
  marca conservan sus colores pero la tarjeta/anillo siguen ahora el tema activo
  en vez de un cuadrado blanco fijo que chocaba con los temas oscuros.

### Corregido

- **Un `LONGTEXT` grande (p.ej. un documento JSON grande) en MySQL se renderizaba
  como un volcado hexadecimal.** Cuando el servidor marca una columna de texto
  como binaria (dependiente de charset/collation), sqlx la reporta como
  `LONGBLOB` y `try_get::<String>` la rechazaba en una comprobación de
  compatibilidad de tipo _antes_ de mirar los bytes, así que el valor caía a hex
  sin importar su contenido. Ahora leemos los bytes crudos y validamos el UTF-8
  nosotros mismos, de modo que el texto UTF-8 válido se decodifica como texto.

## [1.0.9] — 2026-06-09

### Corregido

- **Abrir una base de datos concreta fallaba con "no stored password for keychain
  account" cuando la contraseña venía de la CLI.** Expandir una base de datos en
  el árbol levanta un pool hijo (`open_database_view`) que re-resolvía las
  credenciales desde el llavero del SO — pero una contraseña pasada vía
  `--password` (o el diálogo de conexión) vive solo en memoria y nunca se
  almacenaba allí. El backend mantiene ahora una caché en memoria, solo de sesión,
  del secreto usado al conectar (indexada por perfil, vaciada al desconectar);
  los pools hijos la reutilizan y solo recurren al llavero cuando no se cacheó
  nada.

## [1.0.8] — 2026-06-09

### Añadido

- **Driver de base de datos por defecto configurable** (Ajustes → General). Se usa
  cuando se crea una conexión sin un driver explícito: un lanzamiento por CLI sin
  `--driver`, y el driver inicial del formulario "Nueva conexión". Por defecto es
  **"Preguntar cada vez"** — así que un lanzamiento ad-hoc por CLI (`--host …`)
  sin `--driver` y sin un valor por defecto configurado abre ahora un selector de
  driver (y te anima a fijar uno por defecto) en vez de asumir silenciosamente
  PostgreSQL y desencajar con un servidor MySQL.

### Cambiado

- **`--driver` acepta ahora alias y es insensible a mayúsculas** (`MySQL`,
  `MYSQL`, `mariadb` → mysql; `postgresql`, `pg`, `psql` → postgres; `sqlite3` →
  sqlite). Un valor no reconocido ya no cae silenciosamente a PostgreSQL — enruta
  al selector de driver.
- **Los fallos de conexión causados por un driver desencajado se explican ahora a
  sí mismos.** Cuando un error de protocolo de cable indica el backend equivocado
  (p.ej. el driver de Postgres leyendo un handshake de MySQL — "Postgres protocol
  error … unknown transaction status"), el mensaje de error sugiere ahora cambiar
  de driver, en la Consola y en los diálogos de conexión.

## [1.0.7] — 2026-06-08

### Corregido

- **Las conexiones con SSL desactivado fallaban durante la negociación TLS**
  ("unexpected response from SSLRequest"). Con la casilla de SSL desmarcada la URL
  de conexión no llevaba `sslmode`, así que sqlx recurría a su valor por defecto
  `prefer`/`PREFERRED` — que aún envía un `SSLRequest` de Postgres (o negocia TLS
  de MySQL) y se atraganta contra servidores o poolers que no lo hablan. El
  conmutador de SSL es ahora explícito: off → `sslmode=disable` /
  `ssl-mode=DISABLED` (directo a un arranque en texto plano, sin negociación), on
  → `require` / `REQUIRED`. Un servidor que genuinamente requiere TLS falla ahora
  con un error claro de "activa SSL" en vez de un byte de handshake críptico.

## [1.0.6] — 2026-06-08

### Corregido

- **La sintaxis `--flag=value` de la CLI se ignoraba.** El parser de argumentos de
  arranque solo aceptaba la forma separada por espacios (`--password secret`); la
  forma con igual (`--password=secret`) no coincidía con el flag y el valor se
  descartaba silenciosamente — así que un lanzamiento ad-hoc como
  `huginndb.exe --host … --password=…` creaba el perfil pero reportaba "no
  --password given". El parser acepta ahora ambas formas para cada flag
  (partiendo por el primer `=` para que los valores que contienen `=`
  sobrevivan), con pruebas unitarias que cubren ambas grafías.

## [1.0.5] — 2026-06-08

### Cambiado

- **El diálogo de conexión es ahora un gestor maestro/detalle** (la misma
  disposición que el diálogo de preferencias): un raíl izquierdo lista cada
  conexión guardada con un punto "conectado" en vivo y una entrada "Nueva
  conexión", y el panel derecho edita el perfil seleccionado mediante las
  pestañas General / Túnel SSH. El pie incluye Probar, Conectar (guardar + abrir
  el pool), Borrar (respetando `confirmDestructive`) y Guardar. Abrir desde el
  `+`/editar de la barra lateral sigue funcionando; conectar desde el gestor
  enfoca la conexión en la vista principal. Importar/exportar perfiles viven en la
  cabecera del gestor, y Archivo → "Gestionar conexiones" abre ahora este gestor
  (enfocado en la conexión actual) en vez del antiguo modal envoltorio de lista,
  que se ha eliminado.

### Añadido

- **Los logos oficiales de bases de datos reemplazan las iniciales del driver.**
  Las listas de conexión, el menú de archivo, el desplegable de la barra de estado
  y el gestor de conexiones muestran ahora las marcas de PostgreSQL / MySQL /
  SQLite (incluidas localmente, sin CDN) sobre una tarjeta clara para que los
  logos más oscuros sigan siendo legibles en ambos temas.
- **El logo de la app corona ahora la pantalla de bienvenida del espacio de
  trabajo vacío**, sobre la pista "huginndb — selecciona o crea una conexión".
- **La conexión activa es ahora visible de un vistazo.** El control de conexiones
  de la barra de estado muestra el nombre y el logo de la conexión actual (en vez
  de un mero recuento), y tanto ese desplegable como el menú Archivo marcan la
  conexión enfocada con un check.
- **El panel de previsualización de celda se puede desactivar.** Una nueva
  preferencia `grid.cellPreview` (Ajustes → Rejilla de datos) controla si el panel
  flotante de previsualización de valor aparece al seleccionar una celda. Con él
  desactivado, el clic simple queda como pura navegación; el editor pesado sigue
  accesible vía doble clic y el menú contextual. Por defecto activado (el
  comportamiento histórico).
- **`grid.truncateLongTextAt` se expone ahora en Ajustes** y se aplica de verdad:
  la rejilla limita el texto renderizado de una celda al número de caracteres
  configurado (0 lo desactiva) para que un valor de varios MB no infle el DOM. El
  valor completo sigue disponible en la previsualización/editor.

### Corregido

- **Varias preferencias eran no-ops silenciosos.** Se auditó cada conmutador y se
  cablearon los que no se respetaban:
  - `grid.nullDisplay` — la cadena NULL configurada se renderiza ahora tanto en la
    rejilla de datos como en el panel de previsualización de celda (antes
    hard-codeada `NULL`).
  - `grid.zebraStripes` — se aplican los fondos de fila alternos (se ignoraba).
  - `grid.stickyHeader` — la cabecera de columna solo se fija cuando está activado
    (antes siempre fija).
  - `grid.defaultPageSize` — las nuevas pestañas de tabla abren al tamaño de página
    configurado (antes hard-codeado a 100); el desplegable de tamaño de página
    incluye valores personalizados.
  - `ui.queryHistoryLimit` — el buffer circular del historial de consultas respeta
    el tamaño configurado (antes hard-codeado a 50).
  - `ui.confirmDestructive` — desactivarlo ahora sí salta las confirmaciones de
    borrado (borrar conexión, borrar consulta guardada, borrar filas); la guarda
    de teclear-el-nombre de `DROP TABLE` se mantiene intencionadamente al margen.
- **Ctrl+S en el editor lateral acoplado no limpiaba la guarda de cambios sin
  guardar.** Cuando una celda estaba seleccionada con el panel lateral abierto, el
  panel flotante de previsualización de celda era el que capturaba Ctrl+S y
  persistía _su_ valor obsoleto (pre-edición), así que las ediciones del panel
  lateral no se guardaban y su línea base sucia nunca se reiniciaba — moverse a
  otra celda hacía saltar entonces el diálogo de descartar cambios. El panel
  lateral posee ahora Ctrl+S (fase de captura, con precedencia sobre la
  previsualización): guarda su propio buffer en el sitio, reinicia la línea base y
  mantiene el panel abierto para que puedas seguir sin el aviso.
- **El editor de detalle de la Consola ignoraba las preferencias del editor.**
  Sigue ahora el tema de Monaco, la familia de fuente y el tamaño de fuente
  configurados en vez del modo claro/oscuro de la app y una fuente fija.
- **El autoconectar por CLI no hacía nada para los lanzamientos ad-hoc y fallaba
  silenciosamente.** El manejador de argumentos de arranque estaba supeditado a
  tener al menos un perfil guardado, así que los lanzamientos
  `--host/--port/--database/--driver/--user/--password` se saltaban por completo
  en una máquina sin perfiles; además se tragaba cada error, así que un nombre de
  perfil mal escrito o una conexión fallida no producían feedback. El manejador se
  ejecuta ahora una vez al arrancar independientemente de la lista de perfiles,
  espera un refresco de perfiles antes de emparejar `--connect-profile` por
  nombre/id, y reporta los fallos (perfil no encontrado, error de conexión,
  configuración ad-hoc) en el panel de Consola. El backend además hace eco de los
  flags parseados a stderr al arrancar (contraseña redactada) para que un
  lanzamiento por terminal pueda confirmar que los argumentos llegaron.
- **El túnel SSH no recurría a un puerto alternativo cuando el puerto local fijado
  estaba tomado con acceso exclusivo.** El respaldo ante colisión de bind solo
  reconocía `AddrInUse`; en Windows un puerto tomado por otro túnel/socket abierto
  en uso exclusivo — o dentro de un rango reservado (reservas de `netsh` de
  Hyper-V/WSL) — aparece como `WSAEACCES` (`PermissionDenied`), que se colaba y
  rompía la conexión. El respaldo cubre ahora también `PermissionDenied` y
  `AddrNotAvailable`, reintentando en un puerto asignado por el SO. La
  reasignación se registra en la Consola (no solo en stderr) para que no sea
  invisible.

## [1.0.4] — 2026-06-06

### Añadido

- **Flag `--password`/`--pass` de la CLI y alias `--user`.** La contraseña se
  puede suministrar ahora por línea de comandos tanto para `--connect-profile`
  (sobrescribiendo el secreto guardado en el llavero) como para lanzamientos
  ad-hoc; cuando está presente la app autoconecta sin el diálogo de contraseña. La
  contraseña se usa **solo en memoria** — se pasa directamente a `connect` y nunca
  se escribe en el llavero del SO. `--user` se acepta como alias de `--username`
  para coincidir con la grafía usada por `psql`/`mysql`.

### Corregido

- **Los títulos del panel principal seguían en inglés bajo una interfaz en
  español.** Los paneles del dockview exterior (Esquema, Guardadas, Espacio de
  trabajo, Consola, Celda) tenían títulos en inglés hard-codeados, horneados en la
  disposición persistida, así que nunca seguían el idioma seleccionado. Los
  títulos se obtienen ahora de i18n, se reaplican tras una restauración de
  disposición y se actualizan en vivo cuando cambia el idioma. Las casillas Vista
  → Paneles usan las mismas etiquetas traducidas. Los fallbacks de las pestañas
  internas del espacio de trabajo (las etiquetas por defecto `Query`/`Table` y el
  sufijo `(structure)` en las pestañas del editor de estructura) están ahora
  localizados también.

- **`LONGTEXT`/`TEXT` de MySQL se renderizaban como un blob hexadecimal.** sqlx
  nombra una columna `LONGBLOB`/`BLOB` (en vez de `LONGTEXT`/`TEXT`) a partir del
  flag de columna `BINARY` a nivel de protocolo, que el servidor a veces fija en
  columnas de texto reales dependiendo del charset/collation — así que un campo
  `LONGTEXT` podía aparecer como un volcado hexadecimal (HeidiSQL lo mostraba como
  texto). El decodificador prueba ahora primero una decodificación `String` UTF-8
  y solo recurre a hex para bytes genuinamente no-UTF-8.

- **El túnel SSH se rompía cuando el puerto local configurado ya estaba en
  uso.** Si otro proceso (por ejemplo, un segundo túnel abierto a mano por
  el usuario) ocupaba el `local_port` fijado, el bind fallaba con
  `AddrInUse` y la conexión daba error. El túnel ahora recurre a un puerto
  efímero asignado por el SO y sigue funcionando; el pool sigue el puerto
  realmente vinculado y el perfil guardado se deja intacto.

- **Los campos del formulario de túnel SSH desbordaban el diálogo.** Al
  reconfigurar un túnel existente, los valores largos (en especial la ruta
  de la clave privada) empujaban los inputs y el botón "Examinar" fuera del
  borde del diálogo. Se añadieron restricciones `min-w-0`/`flex-1`/`shrink-0`
  para que los campos se encojan dentro del diálogo en vez de desbordarse.

- **Escritura de columnas `BIT` de MySQL — ruta `insert_row`.** `RowValue`
  ahora lleva un campo opcional `column_type`. Cuando el frontend construye
  el payload de INSERT de la fila borrador, rellena `columnType` a partir de
  `result.columns`, y el backend construye placeholders
  `CAST(? AS UNSIGNED)` para cada columna `BIT` de MySQL en vez de un `?`
  plano. Antes, vincular una cadena como `"1"` a una columna `BIT`
  guardaba el byte ASCII `0x31` (49) en vez del entero 1 — para columnas
  `BIT(n)` anchas esto escribía silenciosamente el valor incorrecto cada
  vez.

- **Escritura de columnas `BIT` de MySQL — ruta `update_cell`.** Se añadió
  un preprocesado `normalize_bit_value` para que la cadena entregada a
  `CAST(? AS UNSIGNED)` sea siempre una cadena de dígitos. Sin esto, si el
  editor de celda producía `"true"` o `"false"` (por ejemplo, tras escribir
  esas palabras en el editor Monaco), MySQL evaluaba
  `CAST('true' AS UNSIGNED)` como 0 sin importar el valor de bit
  pretendido.

## [1.0.3] — 2026-06-03

### Añadido

- **Indicador de paleta de comandos en la barra de estado.** Un pequeño chip
  `Ctrl+K` aparece ahora en la esquina inferior derecha de la barra de estado.
  Al hacer clic abre la paleta de comandos directamente; al pasar el ratón
  muestra el tooltip completo ("Paleta de comandos (Ctrl+K)").

- **Paleta de comandos (`Ctrl`/`Cmd`+K).** Un lanzador centrado en el teclado
  para las acciones que normalmente quedan escondidas en menús: cambiar o
  conectar una base de datos, abrir una tabla del esquema de la conexión activa,
  empezar una consulta, cambiar el tema o el idioma y abrir Preferencias.
  Construida sobre el diálogo de Radix ya incluido más una lista filtrada, sin
  dependencias nuevas. Como Monaco se traga `Ctrl`+K dentro del editor, el editor
  de consultas registra su propio comando para que la paleta se abra
  independientemente del foco (gotcha #9).
- **Desplegable de conexiones activas en la barra inferior.** La lista de
  conexiones abiertas separada por comas pasa a ser un desplegable: las
  conexiones vivas arriba (clic para ir a su espacio de trabajo, o desconectar
  en línea) y los perfiles guardados pero inactivos abajo para conexión rápida.
  Conectar / desconectar replican exactamente el flujo del menú Archivo.
- **Barra inferior enriquecida.** Añade un **contador de selección** de varias
  filas en vivo, un indicador de **solo lectura** para las pestañas de resultado
  de consulta, un **historial de consultas** desplegable y clicable (abre una
  consulta reciente en una pestaña nueva, o la copia cuando su conexión está
  desconectada) y conmutadores rápidos de **densidad de filas** y **claro/oscuro**.
- **Notas del parche en Preferencias → Acerca de.** Un lector por versión que
  toma su contenido del `CHANGELOG.md` incluido, con la versión instalada
  seleccionada por defecto. Cuando el idioma de la interfaz es español lee un
  `CHANGELOG.es.md` paralelo, recurriendo al texto en inglés para cualquier
  versión que aún no esté traducida.

### Changed

- **Acento de marca según el tema.** La paleta, antes totalmente neutra, gana un
  color de acento saturado reservado para acción / estado: botones primarios,
  anillos de foco, enlaces y los marcadores de conexión activa. Es un token
  `brand` por tema (themes.ts): los temas neutros Oscuro / Claro reciben un azul
  (`#0f83fd`) mientras que los temas con carácter (Claude, Solarized, Dim, Alto
  contraste) conservan el suyo. Los temas personalizados guardados antes de que
  existiera el token heredan un valor por defecto en CSS en vez de romperse. Una
  regla `prefers-reduced-motion` reduce las transiciones para quien pida menos
  movimiento.
- **Disposición de ventanas "vista isla".** El armazón de paneles exterior
  (Esquema / Guardadas / Espacio de trabajo / Consola) ahora coloca sus paneles
  como tarjetas separadas y redondeadas sobre un fondo sutil en vez de regiones
  pegadas borde con borde, dando a cada ventana un pequeño margen y una
  separación más clara. El área interior de pestañas (tablas y consultas
  abiertas) permanece a ras y sin cambios.

### Fixed

- **CodeLens "▶ Run" duplicado (y sugerencias de autocompletado duplicadas) con
  varias pestañas de query abiertas.** Los `registerCompletionItemProvider` /
  `registerCodeLensProvider` / `registerCommand` de Monaco son globales al
  lenguaje, pero se registraban dentro del `onMount` de cada editor de query, así
  que cada pestaña abierta añadía otro proveedor — N pestañas producían N "▶ Run"
  en cada sentencia y N copias de cada sugerencia. Ahora los proveedores se
  instalan una sola vez por instancia de Monaco (`src/lib/monacoSql.ts`) y
  despachan por modelo mediante un registro en el que cada editor se inscribe al
  montarse y se da de baja al desmontarse.
- **Legibilidad del tab strip interno y seguimiento de la pestaña activa.** La
  pestaña activa (query/tabla) lleva ahora un acento de marca y sigue
  correctamente al panel activo (la pestaña personalizada deriva su estado activo
  del store en vez de un `props.api.isActive` obsoleto), el strip es más alto con
  estados hover más claros, y los iconos de cerrar / dividir (⋮) / nueva query
  (+) se ven bien en temas oscuros.
- **Traducción al español incompleta.** Varios paneles y diálogos seguían
  mostrándose en inglés sin importar el idioma seleccionado. Se migraron al
  sistema i18n el panel de Consola, el editor de consultas (barra lateral de
  historial, tooltips, estados vacíos, pistas de ejecución), el panel de
  Consultas guardadas, el diálogo de Guardar consulta, el input de celda en
  línea, el límite de error de conexión, el menú contextual de la rejilla de
  datos (copiar, copiar fila como, poner NULL, filtrar por / excluyendo valor,
  insertar / duplicar / borrar fila y las acciones masivas de varias filas), la
  barra de la rejilla (filtro de filas, recuento, insertar, chips de filtro de
  servidor) y la barra del navegador de tablas (refrescar, paginación, tamaño de
  página, estado de carga y el diálogo de confirmación de borrado). El español
  cubre ahora toda la interfaz.

## [1.0.2] — 2026-06-02

### Added

- **Importar / Exportar perfiles de conexión.** Exporta todos los perfiles o una
  selección a un archivo JSON portable (`Archivo → Exportar perfiles…` o los
  iconos en _Gestionar conexiones_). Los perfiles pueden incluir credenciales
  opcionalmente: cada contraseña y secreto SSH se cifra individualmente con
  AES-256-GCM, con clave derivada vía PBKDF2-HMAC-SHA256 a 600 000 iteraciones,
  de modo que el archivo es seguro de almacenar o enviar. La importación detecta
  el cifrado, guía por un paso de contraseña cuando hace falta, muestra una
  pantalla de resolución de conflictos cuando los IDs colisionan (sobrescribir /
  omitir / conservar ambos) y siempre asigna UUIDs nuevos a los perfiles
  importados para evitar colisiones en el llavero. Los perfiles importados sin
  contraseña se señalan en el resumen del resultado.
- **Argumentos de conexión por CLI.** HuginnDB se puede lanzar con flags de
  conexión para que herramientas externas lo abran preconectado.
  `--connect-profile <nombre>` autoconecta a un perfil guardado por su nombre
  mostrado; `--connect-profile-id <uuid>` usa el ID estable. Para conexiones
  ad-hoc sin perfil guardado: `--host`, `--port`, `--database`, `--username`,
  `--driver`, `--name` — la app se abre con el perfil precargado y pide la
  contraseña por el diálogo normal (las contraseñas nunca se aceptan por CLI).
  Los flags desconocidos se ignoran silenciosamente por compatibilidad futura.
- **Filtro multi-BD con ámbito (estilo HeidiSQL).** En conexiones
  multi-base-de-datos, el filtro del explorador de esquemas ahora se acota a la
  base de datos activa en vez de buscar en todas a la vez. Expandir una base de
  datos la activa como ámbito del filtro; el placeholder del input pasa a
  "Filtrar en `<bd>`…" y una pista bajo el input confirma el ámbito mientras
  escribes. Abrir una tabla desde resultados entre-BD activa automáticamente esa
  base de datos, colapsa las demás y fija el ámbito. Sin ninguna base de datos
  expandida el filtro vuelve al comportamiento anterior (busca en todas),
  manteniendo el caso de una sola BD totalmente retrocompatible.
- **Editor visual de estructura de tablas (estilo HeidiSQL).** Clic derecho en
  una tabla → _Editar estructura…_ (o _Nueva tabla…_) abre un editor de columnas
  (añadir/quitar/renombrar, tipo, nulabilidad, valor por defecto, clave primaria,
  autoincremento), índices y claves foráneas, incluidas las compuestas. El tipo
  de columna es un combobox editable precargado con los tipos comunes del driver
  para evitar erratas pero permitiendo afinar (p.ej. `varchar(40)`). Sigue un
  modelo de previsualizar-y-aplicar: el backend genera DDL específico del driver
  (PostgreSQL / MySQL / SQLite) que se muestra en una previsualización de solo
  lectura antes de aplicarlo de golpe. En SQLite, los cambios que `ALTER TABLE`
  no puede expresar (tipo / nulabilidad / PK / FK) recurren a la reconstrucción
  canónica de 12 pasos, protegida tras una confirmación destructiva explícita.
  Todos los identificadores se validan antes de entrecomillar; los tipos y
  valores por defecto pasan por una lista de permitidos conservadora.
- **Editor de celda en panel lateral (estilo JetBrains).** Los valores de celda
  grandes ahora pueden editarse en un panel acoplado a la derecha en vez de un
  diálogo centrado. Se llega vía clic derecho → _Abrir en editor lateral_, o el
  nuevo botón _Mover al panel lateral_ dentro del editor modal (que arrastra el
  buffer en curso). Una nueva preferencia _General → Editor de celda_
  (`cellEditorMode`: Diálogo / Panel lateral) elige dónde se abre el editor al
  expandir una celda. El panel es un panel dockview real, así que se redimensiona,
  acopla y flota como los demás.
- **Selección de varias filas con copia y borrado masivos.** Selecciona varias
  filas como en el explorador de archivos de tu sistema: `Ctrl`/`Cmd`+clic
  alterna filas individuales y `Mayús`+clic extiende un rango contiguo. El clic
  derecho sobre la selección ofrece _Copiar N filas como ▸ JSON / SQL INSERT /
  SQL UPDATE_ (reutilizando los formateadores por fila ya existentes) y _Borrar N
  filas_. Todo borrado —individual o masivo— pasa por el mismo diálogo de
  confirmación. La selección se indexa por clave primaria, así que sobrevive a la
  ordenación, el filtrado en cliente y los refrescos (solo disponible en tablas
  con clave primaria).
- **La disposición dividida/flotante del espacio de trabajo ahora persiste por
  conexión.** Una disposición de dos paneles (o flotante) dentro de un espacio de
  trabajo se captura como un blob `toJSON()` de dockview en `tab_state.json`
  (`internalLayout`) y se restaura con `fromJSON` al reabrir, en vez de volver
  siempre como paneles en pestañas simples. Solo se guarda cuando existe una
  división real; ante cualquier deriva de la disposición vuelve al modo de
  pestañas por defecto.

### Fixed

- **Editar una celda `BIT` de MySQL escribía basura.** `update_cell` envía el
  valor como literal de texto y deja que el driver lo convierta. Para `BIT`,
  MySQL lee la cadena `"1"` como el byte ASCII `0x31` (el carácter `'1'`) en vez
  del entero 1, así que guardar una celda BIT la corrompía silenciosamente —
  mientras que `VARCHAR`/`TEXT` funcionaban porque aceptan la cadena directamente.
  El frontend ahora reenvía el tipo crudo de la columna a `update_cell`, que
  envuelve el placeholder en `CAST(? AS UNSIGNED)` para columnas `BIT` de MySQL
  (seguro ante NULL), forzando la interpretación numérica. PG/SQLite no cambian.
- **`TINYINT` de MySQL (y otros anchos enteros no-`i64`) se mostraban como
  `NULL`.** sqlx asigna cada ancho entero de MySQL a un tipo Rust específico
  (`TINYINT` → `i8`, `… UNSIGNED` → `u8`/`u32`/`u64`, …) y rechaza un `try_get`
  con tipo distinto, así que `try_get::<i64>` fallaba para todo lo que no fuera
  compatible con signed-64-bit y la celda colapsaba a `NULL` — la misma clase de
  bug arreglada antes para `BIT`. `mysql_value` ahora prueba en cascada los
  anchos con y sin signo antes de rendirse a `NULL`, de modo que `TINYINT`/
  `SMALLINT` y las columnas sin signo muestran su valor real. `TINYINT(1)`/`BOOL`
  siguen decodificándose como booleanos (esa rama queda por encima de la
  comprobación genérica de `INT`).
- **Panel de conexión en blanco al limpiar un filtro multi-BD.** En una conexión
  multi-base-de-datos, escribir un filtro y luego limpiarlo podía dejar en blanco
  todo el panel de esquema (la barra exterior Archivo/Vista/Espacios seguía
  visible). Causa raíz: un `useMemo` en el explorador de una sola base de datos
  quedaba _por debajo_ del early-return `if (!cs) return`, así que cuando el
  segmento de esquema por conexión pasaba brevemente a `undefined` al desmontarse
  exploradores anidados, React renderizaba un número distinto de hooks entre
  renders y lanzaba un error. El hook ahora va por encima del early-return
  (recuento de hooks constante) y la agrupación es estable por referencia. Un
  nuevo `ConnectionErrorBoundary` envuelve los paneles de esquema y de espacio de
  trabajo para que cualquier futuro fallo de render degrade a una tarjeta de
  error legible con reintento en vez de una pantalla en blanco.

## [1.0.1] — 2026-05-30

Primera versión de parche. Arregla el renderizado de `BIT` de MySQL que la 1.0.0
publicó roto, y reelabora la edición de celdas de la rejilla hacia un flujo
en-línea-primero con un zoom de fila persistente estilo HeidiSQL. El estado en
disco no se toca.

### Added

- **Edición de celda en línea.** Hacer doble clic en una celda de la rejilla
  ahora la edita en el sitio con el mismo input de una línea usado por la fila
  borrador de inserción, en vez de abrir siempre el gran diálogo de Monaco. Un
  botón de _expandir_ en el editor en línea (y el F11 existente en la
  previsualización de celda) escala al modal completo para valores JSON / largos
  / multilínea. Las columnas de clave foránea conservan su combobox en línea; los
  resultados de consulta de solo lectura siguen abriendo el modal como visor. El
  input simple + el control `∅` de poner-NULL es ahora un componente `CellInput`
  compartido reutilizado por la fila borrador y la edición en línea.
- **Zoom de fila persistente.** La rejilla respeta `gridPrefs.rowHeight` (un zoom
  estilo HeidiSQL): `Ctrl` + rueda del ratón sobre la rejilla y los botones
  `+`/`−` en la barra de la tabla agrandan o encogen a la vez la altura de fila,
  el relleno y el tamaño de fuente. El nivel se guarda en `prefs.json` y
  sobrevive a los reinicios.

### Fixed

- **Las columnas `BIT` de MySQL se mostraban como `NULL`.** `sqlx` se niega a
  decodificar un `Vec<u8>` de una columna `MYSQL_TYPE_BIT` (su comprobación de
  compatibilidad de tipo blob solo acepta BLOB/STRING/VARBINARY), así que el
  valor colapsaba a `NULL` en la rejilla aunque la fila tuviera un valor real.
  `mysql_value` ahora lee los bytes directamente del `ValueRef`, plegándolos en
  big-endian a un entero (`BIT(1)` → 0/1, `BIT(n)` más anchos → su valor
  numérico). Los booleanos (`BOOL` / `TINYINT(1)`) también se decodifican ahora
  antes de la comprobación genérica de `INT`, que antes los ensombrecía.

## [1.0.0] — 2026-05-29

Primera versión estable. El ciclo alfa (0.x) se cierra con el espacio de trabajo
convertido en una superficie estilo editor de código, el explorador
multi-base-de-datos volviéndose instantáneo en la primera pulsación, y dos
defectos específicos de MySQL corregidos. Los datos existentes en disco
(`profiles.json`, `tab_state.json`, `prefs.json`) se conservan sin migración. A
partir de aquí el proyecto sigue SemVer.

### Added

- **Espacio de trabajo estilo editor.** Las pestañas de tabla y consulta abiertas
  ahora viven en una instancia dockview anidada en vez de una tira de pestañas
  plana, así que el espacio de trabajo se comporta como un editor de código: las
  pestañas se pueden dividir horizontal o verticalmente, arrastrar entre grupos y
  sacar a una ventana flotante. Las pestañas también se pueden cerrar con clic de
  rueda (botón central) además del botón X. Cada pestaña expone también un menú
  explícito `⋮` con _Dividir a la derecha_, _Dividir abajo_, _Flotar en ventana
  nueva_ y _Cerrar_ para quien prefiera acciones de menú al arrastrar y soltar.
  `useTabs` sigue siendo la fuente de la verdad —los paneles dockview se
  reconcilian contra él— así que la restauración de pestañas por conexión sigue
  funcionando. La geometría de división/flotación es solo de sesión; las pestañas
  restauradas vuelven en la disposición de pestañas por defecto.
- **Las columnas `BIT` de MySQL ahora son configurables en la rejilla.** Una
  nueva preferencia **Visualización de BIT** (Ajustes → Rejilla) renderiza los
  valores `BIT` como `true`/`false` (por defecto) o `0`/`1`. El backend siempre
  envía el valor como número, así que alternar la preferencia re-renderiza sin
  re-consultar.

### Changed

- **El filtrado multi-base-de-datos ahora es instantáneo.** El filtro a nivel de
  conexión solía desplegar `openDatabaseView` + `list_tables` por cada base de
  datos del servidor en la _primera_ pulsación, así que la búsqueda inicial en un
  servidor con muchas bases de datos se atascaba durante segundos. Una conexión
  multi-BD ahora precalienta toda su caché de tablas en segundo plano en cuanto se
  conoce la lista de bases de datos (`warmDatabases` en `src/stores/schema.ts`),
  con concurrencia acotada para no abrir todos los pools a la vez. El filtro lee
  directamente de esa caché; una línea de progreso sutil muestra cuántas bases de
  datos quedan. El prefetch bajo demanda anterior se conserva como respaldo para
  las bases de datos que el precalentado aún no haya alcanzado.

### Fixed

- **El arrastrar y soltar HTML5 en el espacio de trabajo estaba completamente
  roto en Windows.** Arrastrar una pestaña del editor producía el cursor de "no
  se permite soltar" por toda la pantalla — no aparecía overlay de destino, nada
  aceptaba la soltada. El `dragDropEnabled` de Tauri 2 vale `true` por defecto, lo
  que enruta los eventos de arrastre por el manejador de soltado de archivos del
  SO y se adelanta a los eventos HTML5 en los que se apoyan los listeners
  `Droptarget` de dockview (`tauri-utils` lo documenta literalmente:
  _"Disabling it is required to use HTML5 drag and drop on the frontend on
  Windows"_). La config de la ventana ahora pone `dragDropEnabled: false`.
  HuginnDB no acepta soltado de archivos del SO de todas formas (la ruta SQLite se
  elige por un diálogo de archivo), así que no hay pérdida funcional.
- **El divisor entre grupos de dockview era casi invisible.** `.dv-sash` estaba
  forzado a z-index 1 (para que los portales de Radix siempre lo taparan) y
  tintado con `--border`, que en el tema oscuro se fundía con el contenido del
  panel. Una división vertical parecía no haber hecho nada aunque dockview hubiera
  dispuesto un grupo nuevo debajo. El sash ahora vive en z-index 10 (todavía
  seguro por debajo de Radix en 50) con un tinte de divisor explícito, y el
  relleno de arrastre-encima subió de 0.18 a 0.40 alfa para que los cuadrantes de
  soltado destaquen sobre superficies de Monaco / rejilla.
- **Las acciones "Dividir a la derecha" / "Dividir abajo" del menú `⋮` no hacían
  nada.** Llamaban a `panel.api.moveTo({ position })` sin un `group`, pero
  `DockviewPanelApiImpl.moveTo` fuerza `position` a `"center"` cuando
  `options.group` es undefined — mover el panel al centro de su propio grupo es un
  no-op. Pasar el propio grupo del panel como referencia hace que dockview cree un
  grupo nuevo adyacente en el lado pedido.
- **MySQL/MariaDB lanzaba el error 1064 al filtrar una tabla.** La cláusula de
  búsqueda entre columnas emitía `... LIKE ? ESCAPE '\'` para todos los drivers.
  En MySQL la contrabarra dentro del literal de cadena escapa la comilla de
  cierre, dejándola sin terminar y disparando un error de sintaxis (el filtro aún
  devolvía filas porque las consultas de datos y `COUNT(*)` se ejecutan por
  separado, pero aparecía el banner de error). La cláusula `ESCAPE` es ahora
  específica del driver: MySQL recibe `ESCAPE '\\'` (interpretado como una sola
  contrabarra, igual que `escape_like`), mientras que Postgres/SQLite mantienen el
  `ESCAPE '\'` estándar. Centralizado en un nuevo helper `like_escape_clause`
  usado por el filtro de tabla y la búsqueda de opciones de FK
  (`src-tauri/src/commands/query.rs`).
- **Las columnas `BIT` de MySQL se mostraban como NULL.** `mysql_value`
  (`src-tauri/src/db/values.rs`) no tenía rama para `BIT`, así que el valor
  binario de sqlx caía al respaldo de `String`, no se decodificaba y aparecía como
  NULL. Una rama dedicada pliega ahora los bytes crudos en un entero sin signo
  big-endian y lo envía como número.
