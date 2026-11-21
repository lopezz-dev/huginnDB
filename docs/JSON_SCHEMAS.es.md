# Esquemas JSON

Vincula un esquema JSON a una columna y el editor de celda empieza a ayudarte:
completa nombres de propiedades, sugiere valores de enumeración, muestra la
descripción de cada propiedad al pasar el ratón y subraya los valores que no
encajan.

Esto existe para una situación concreta y bastante común: una base de datos usada
como **almacén de configuración**. Las columnas de tipo `json`, `jsonb` o `TEXT`
acaban conteniendo documentos de cientos de líneas que describen widgets,
gráficos, paneles o feature flags. Esos documentos tienen un contrato real; lo
único es que no está escrito en ningún sitio. Hasta ahora HuginnDB trataba todos
ellos como JSON anónimo: resaltado de sintaxis, una insignia de válido/no válido y
nada más.

Dos cosas antes de nada:

- **La validación nunca impide guardar.** La base de datos es la autoridad; un
  esquema es una ayuda. Si tu esquema resulta estar ligeramente mal, sigues
  pudiendo editar tus propios datos.
- **Nunca se descarga nada de la red.** Los esquemas viven en tu máquina, y un
  `$ref` que apunte a un registro público no se descarga. Mira
  [Lo que esto no es](#lo-que-esto-no-es) para saber qué implica en la práctica.

## La vía de 30 segundos

1. Abre una celda con un documento JSON y pulsa el botón de expandir para llegar
   al editor Monaco (o usa el editor lateral acoplado).
2. En la cabecera del editor, junto a la insignia `JSON válido`, está la insignia
   de esquema. Sin nada vinculado dice **sin esquema**.
3. Púlsala → **Crear a partir de este valor**. HuginnDB redacta un esquema a
   partir del documento que tienes delante.
4. Ponle un nombre y pulsa **Crear**. Se guarda en tu biblioteca y se vincula a
   esta columna en un solo paso.

Escribe ahora un `"` dentro del documento y se te ofrecen los nombres de propiedad
de tus propios datos. Eso es la feature entera funcionando.

Refina el borrador después en **Ajustes → Esquemas JSON**.

## La biblioteca

Una entrada de la biblioteca es un nombre, una descripción opcional y el propio
documento del esquema. Las entradas viven en `json_schemas.json`, dentro del
directorio de configuración de HuginnDB.

La biblioteca es **global**. No forma parte de un entorno y no se sincroniza en
ningún sitio. Es deliberado: un vínculo dice «la columna de esta tabla tiene esta
forma», que es un hecho sobre el *servidor*, no sobre si estás mirando Producción
o Staging. Si la biblioteca viviera dentro de un entorno, la misma tabla tendría
esquema en un entorno y no en otro.

El documento se guarda tal y como lo escribiste, carácter por carácter. Eso
significa que un esquema a medio escribir se guarda igual: simplemente no se
aplica hasta que sea JSON válido, y Ajustes lo marca con un `⚠` mientras no lo
sea.

## Vincular una columna

Hay tres sitios que pueden crear un vínculo. Escriben en la misma lista; usa el
que tengas delante.

**La insignia del editor de celda.** La que importa. Funciona con todos los
drivers, te dice qué esquema está en efecto, y su desplegable vincula cualquier
entrada de la biblioteca, redacta una nueva a partir del valor actual, o
desvincula. Es la única superficie disponible en MongoDB y SQL Server.

**Ajustes → Esquemas JSON.** La vista canónica: la biblioteca a un lado, el
documento de la entrada seleccionada al otro, y debajo la lista completa de
vínculos en el orden en que se resuelven.

**El editor de estructura de tabla.** Un pequeño botón `{}` por columna, detrás de
un separador discontinuo y con la etiqueta `local`. Se guarda en el momento en que
eliges algo y **nunca forma parte del DDL** que aparece debajo: un vínculo es
metadato del editor, no un cambio de esquema, así que pulsar *Aplicar* ni lo
incluye ni es necesario para él. Esta pestaña no existe en MongoDB ni en SQL
Server, y por eso es un añadido y no la vía principal.

El botón de expandir de una celda en línea también cambia: cuando la columna tiene
esquema, muestra un icono `{}` y nombra el esquema en su tooltip. Hacer doble clic
en una celda sigue abriendo el mismo editor en línea de una sola línea de siempre.

## La cascada

Un vínculo nombra cuatro cosas, y todas menos la columna se pueden dejar en
**cualquiera**:

| Eje | Significado |
| --- | --- |
| Conexión | Una conexión guardada, o cualquiera |
| Esquema / base de datos | Un esquema de Postgres, una base de datos de MySQL o MongoDB, `main` en SQLite, o cualquiera |
| Tabla | Una tabla, un patrón, o cualquiera |
| Columna | Obligatorio. Una columna, o un patrón |

Cuando más de un vínculo coincide con una columna, **gana el más específico**. La
especificidad se decide eje por eje, en este orden de importancia:

    columna  >  tabla  >  esquema/base de datos  >  conexión

y dentro de cada eje un nombre exacto gana a un patrón, que gana a *cualquiera*.

Ese orden es lo que hace que funcione el caso que motivó todo esto. Supón que
`configuration` es una columna JSON en una docena de tablas, casi siempre con la
misma forma, pero `widgets` es distinta:

| # | Conexión | Esquema | Tabla | Columna | Esquema |
| --- | --- | --- | --- | --- | --- |
| 1 | `*` | `*` | `widgets` | `configuration` | widget-config |
| 2 | `*` | `*` | `*` | `configuration` | base-config |

La fila 1 gana en `widgets`; la fila 2 cubre todo lo demás. Una regla extra, no
doce.

La conexión es el eje *menos* importante, lo que sorprende. Está pensada para
distinguir dos reglas por lo demás idénticas: «esta misma tabla y columna, pero
solo en el servidor de producción». Una regla general sobre una conexión entera no
debería ganar a una regla que nombra la tabla y la columna exactas, y no lo hace.

Si dos vínculos son igual de específicos, gana el que aparece primero en Ajustes.
El orden de la lista es lo que rompe ese empate.

### Patrones

Solo `*` es especial, y coincide con cualquier secuencia de caracteres:

- `*_json` coincide con `payload_json` y `settings_json`
- `widget_*` coincide con `widget_layout`
- `*` a solas es lo mismo que *cualquiera*

La coincidencia **no distingue mayúsculas**, así que no necesitas saber cómo plega
los identificadores tu motor (Postgres los pasa a minúsculas, MySQL depende del
sistema de ficheros, MongoDB los distingue).

El `.` **no** es especial. Eso importa en MongoDB, donde un campo anidado se
direcciona por su ruta con puntos, la misma forma que usa `$set`: un vínculo sobre
`customData` se aplica solo a ese campo, y `customData.*` es lo que alcanza los
campos de dentro.

### ¿Por qué no se aplica mi regla?

Ajustes tiene una caja **Probar una columna**. Escribe `esquema.tabla.columna` (o
solo un nombre de columna) y te dice a qué esquema se resuelve, usando exactamente
el mismo resolutor que usa el editor, así que la respuesta no puede discrepar de lo
que ves al editar.

Las dos causas habituales:

- **El eje de esquema/base de datos no coincide con lo que la pestaña llama así.**
  En MySQL y MongoDB ese valor es la *base de datos*; en Postgres es el esquema; en
  SQLite suele ser `main`. En caso de duda, déjalo en *cualquiera*.
- **El documento declara su propio `$schema`.** Ver más abajo.

## Qué hace el editor con un esquema

Tres interruptores en Ajustes → Esquemas JSON, separados porque el editor los
separa: un esquema aproximado ya es útil para autocompletar mucho antes de que
quieras subrayados rojos.

- **Validar contra el esquema vinculado**: los subrayados. Desactivarlo deja
  funcionando el autocompletado y la ayuda al pasar el ratón. En ningún caso
  condiciona el guardado.
- **Sugerir claves y valores**: nombres de propiedad y valores de enumeración
  mientras escribes.
- **Mostrar descripciones al pasar el ratón**: lee la `description` de cada
  propiedad.

Añadir una `description` a tus propiedades es lo que más rendimiento da aquí:
convierte un blob de configuración de 300 líneas en algo que un compañero puede
leer.

## Límites del esquema inferido

«Crear a partir de este valor» inspecciona el documento y escribe un esquema
permisivo. Es un punto de partida, y conocer sus reglas evita sorpresas:

- Toda propiedad vista se convierte en propiedad. Las claves extra siguen
  permitidas salvo que marques **Objeto estricto**.
- `required` lista solo las claves presentes en **todas** las muestras. Cualquier
  otra cosa produciría un esquema que rechaza las filas de las que se redactó.
- Un número entero se considera `integer` hasta que aparece uno con decimales,
  momento en el que pasa a `number`.
- Un campo que a veces es `null` recibe ambos tipos.
- Un campo que contuvo tanto un objeto como un valor simple pasa a `anyOf`, y el
  diálogo dice qué campos fueron.
- Un `enum` solo se escribe cuando un valor **se repitió** de verdad. Tres valores
  distintos en tres filas son un tamaño de muestra, no un conjunto cerrado.
- Un `format` (`date`, `date-time`, `uuid`, `email`) solo se escribe cuando hay al
  menos dos muestras y todas coinciden.
- Los arrays se muestrean a 50 elementos y el anidamiento se corta a 12 niveles de
  profundidad; el diálogo avisa cuando ocurre cualquiera de las dos cosas.
- Un campo visto solo como `null` se tipa como `null`: normalmente conviene
  editarlo a mano.

El resultado es determinista: redactar dos veces a partir del mismo documento da
un esquema idéntico byte a byte, así que regenerar produce un diff legible.

## Compartir

**Exportar / importar un archivo.** Archivo → *Exportar esquemas JSON* escribe las
entradas que elijas, opcionalmente con sus vínculos. No hay contraseña, porque en
un esquema no hay nada secreto.

**Incluirlos en la exportación de un entorno.** El diálogo de exportación de
entornos tiene un interruptor opcional. Los esquemas son globales, no propiedad del
entorno, así que esto empaqueta la biblioteca completa junto a él: cómodo para
preparar una máquina nueva con un solo archivo.

**A través de un origen compartido (1.19.0).** Un origen apuntado a una
exportación de entorno ya sincroniza los esquemas que lleve ese archivo junto con
sus conexiones, así que un solo archivo sí mantiene al día la biblioteca de un
equipo. Las reglas son las mismas que siguen las conexiones: una entrada se
empareja por **id**, no por nombre, así que volver a sincronizar el mismo archivo
cada pocas horas la actualiza en su sitio en vez de acumular `cfg (2)`,
`cfg (3)`, …; solo se sobrescriben las entradas que el origen ya posee, de modo
que un esquema que hayas escrito tú no se toca nunca, y uno cuyo nombre choque con
el tuyo se aparta en lugar de renombrar el tuyo; y no se borra nada: una entrada
que desaparezca del archivo se reporta, nunca se elimina, por la misma razón que
una conexión desaparecida.

Si eres quien publica, en Ajustes → Orígenes compartidos → «Editar el
documento» eliges qué esquemas y qué vínculos viajan; ver
`docs/ENVIRONMENTS.es.md`.

**Una advertencia, en ambos casos.** Un vínculo fijado a una *conexión* la
referencia con un identificador local a la máquina que la creó. Al importarlo en
otra, ese vínculo llega **desactivado**, conservando su ámbito para que puedas ver
qué significaba y apuntarlo a la conexión correcta. No se ensancha a «cualquier
conexión» (eso cambiaría el significado de la regla) ni se descarta en silencio. El
asistente de importación te dice el número antes de escribir nada.

Los vínculos que no están fijados a una conexión viajan sin nada de esto, lo que es
una buena razón para dejar ese eje en *cualquiera* en los esquemas que pienses
compartir.

## Lo que esto no es

- **No es una restricción del servidor.** No se escribe nada en la base de datos.
  La validación es local, orientativa y nunca impide guardar.
- **No es un registro de esquemas en línea.** Un `$ref` a una URL `http://` o
  `https://` nunca se descarga. Peor aún: una sola referencia sin resolver impide
  que se valide el documento entero, así que el esquema parece no hacer nada en
  absoluto. Ajustes te avisa justamente de esto, y la solución es incorporar la
  parte referenciada. Las referencias entre dos entradas de tu propia biblioteca sí
  funcionan.
- **No es el validador de colección de MongoDB.** El `$jsonSchema` de MongoDB es
  una regla del servidor que se aplica en las escrituras, y un dialecto distinto
  (con sabor a BSON). Es otra feature, aún no implementada.
- **No es por entorno.** Ver [La biblioteca](#la-biblioteca).

Un comportamiento más que conviene conocer, porque es la sorpresa más probable en
el caso del almacén de configuración: si el propio documento contiene una clave
`"$schema"` de primer nivel, esa declaración **tiene prioridad sobre tu vínculo**,
y el editor lo dice en la insignia. Si la URL que nombra coincide con una de las
entradas de tu biblioteca, todo funciona en local; si no, no se valida nada, porque
la referencia no se puede resolver sin conexión.

## Dónde vive cada cosa

| Qué | Dónde |
| --- | --- |
| La biblioteca y sus vínculos | `json_schemas.json`, en el directorio de configuración |
| Los tres interruptores de comportamiento | `prefs.json`, con el resto de ajustes del editor |
| Las reglas de resolución | Implementadas una sola vez, en el backend de Rust: la interfaz nunca las reimplementa |

Borrar una conexión elimina los vínculos fijados a ella, e indica cuántos. Los
esquemas en sí no se tocan nunca: el identificador de una conexión no se reutiliza
jamás, así que ese vínculo no podría volver a coincidir, mientras que un esquema es
algo que escribiste tú.

Borrar un esquema elimina los vínculos que apuntan a él, y te dice cuántos antes de
que confirmes.
