# Bloqueo de la app

> Nota: este archivo es la traducción al español de `APP_LOCK.md`. Si ves algo
> desactualizado respecto al original en inglés, ese es el que manda.

El bloqueo de la app pide una contraseña maestra antes de que HuginnDB muestre
nada. Está desactivado hasta que lo actives en **Ajustes → Seguridad**.

## Contra qué protege

Contra alguien que se siente en tu ordenador mientras tu sesión de Windows
está abierta: un compañero mientras vas a por un café, o un portátil que se
queda desbloqueado en una sala de reuniones.

Con el bloqueo activado, esa persona:

- **no puede abrir HuginnDB.** La app solo muestra la pantalla de bloqueo. Tus
  conexiones, las pestañas, el árbol del esquema y el panel de IA no se cargan
  hasta que desbloqueas.
- **no encuentra tus contraseñas en Windows.** Al activar el bloqueo, todos los
  secretos que guarda HuginnDB salen del llavero del sistema (el Administrador
  de credenciales de Windows) y pasan a una bóveda cifrada. Solo la contraseña
  maestra la abre. Eso incluye las contraseñas de las conexiones, las
  contraseñas y frases SSH, las frases de los orígenes compartidos, la clave
  de API del panel de IA y el token de GitHub del formulario de incidencias.
- **no puede usar el conector MCP.** Claude Desktop, Cursor y los demás
  clientes reciben la respuesta *"HuginnDB is locked: open the HuginnDB app and
  unlock it"* hasta que desbloquees. El conector no puede abrir la bóveda por
  su cuenta.
- **no gana nada borrando los ficheros de HuginnDB.** Los secretos están en la
  bóveda, no en los ficheros. Si borra la bóveda o los ajustes, se queda con
  una app sin contraseñas, no con una app sin bloqueo.

## Contra qué no protege

Díselo claramente a quien dependa de él:

- **Malware, un keylogger o alguien con acceso prolongado a tu cuenta.** Un
  programa que se ejecuta como tú puede capturar la contraseña maestra
  mientras la escribes, o leer la memoria mientras HuginnDB está
  desbloqueado.
- **Los ficheros del disco que no son secretos.** Los nombres y hosts de las
  conexiones (`profiles.json`), las consultas de las pestañas restauradas
  (`tab_state.json`), el historial de consultas y el historial de Pulse se
  siguen guardando sin cifrar. Quien pueda leer tu carpeta de usuario puede
  leerlos. Está previsto cifrarlos en una versión posterior.
- **Las conexiones que no necesitan contraseña.** Un fichero SQLite, o un
  servidor que confía en tu equipo, no necesita ningún secreto, así que
  cualquiera que llegue al fichero o al servidor puede abrirlo con otra
  herramienta.
- **Quien ya tenga la contraseña de la base de datos.** Puede usar cualquier
  otro cliente.

## Activarlo

1. Abre **Ajustes → Seguridad** y elige **Activar el bloqueo de la
   app…**.
2. Elige una contraseña maestra de al menos 12 caracteres. Unas cuantas
   palabras sin relación entre sí, separadas por espacios, se recuerdan mejor
   que una contraseña corta llena de símbolos, y cuestan más de adivinar.
3. Confirma que entiendes el aviso de abajo. HuginnDB pasa tus secretos a la
   bóveda y te dice cuántos ha movido.

> **Si olvidas la contraseña maestra, nadie puede recuperar los secretos de la
> bóveda, ni siquiera HuginnDB.** Tus conexiones se conservan, pero tendrás que
> volver a escribir todas las contraseñas.

## Cuándo se bloquea

- Cada vez que HuginnDB arranca.
- Tras un rato sin pulsar una tecla, hacer clic ni desplazarte en ninguna
  ventana de HuginnDB: 15 minutos por defecto. Puedes cambiarlo, o
  desactivarlo, en **Bloquear tras inactividad**.
- Cuando se bloquea la sesión de tu equipo: **Win+L**, el bloqueo del
  protector de pantalla, o al desconectarte de una sesión de Escritorio remoto
  (cerrar el cliente deja la sesión abierta en el servidor). En Linux, cuando
  el escritorio bloquea la sesión a través de logind, como hacen GNOME y KDE.
  Se desactiva con **Bloquear con la sesión**.
- Cuando pulsas **Ctrl+L** (o eliges **Bloquear ahora** en Ajustes). El atajo
  se puede cambiar en **Ajustes → Atajos**.

Al bloquearse se cierran todas las ventanas salvo la principal, todas las
conexiones a bases de datos y los túneles SSH, y se borra la conversación del
panel de IA. Desbloquear no reconecta nada: vuelves a abrir lo que necesites.

## Contraseñas incorrectas

Tras tres intentos fallidos seguidos, HuginnDB te hace esperar antes del
siguiente: dos segundos al principio, el doble cada vez, hasta cinco minutos.
Así se frena a quien intente adivinarla en la pantalla de bloqueo. Esto no
protege una copia del fichero de la bóveda sacada del equipo: ahí solo la
protegen la longitud de tu contraseña maestra y lo que cuesta comprobarla
(Argon2id, alrededor de un tercio de segundo por intento). Por eso importa más
que la contraseña sea larga que complicada.

## Si olvidas la contraseña maestra

En la pantalla de bloqueo, elige **¿Has olvidado la contraseña maestra?**.
Puedes restablecer la bóveda:

- se borran todos sus secretos, y no se pueden recuperar;
- tus conexiones, entornos y ajustes se quedan como están;
- eliges una contraseña maestra nueva, y el bloqueo sigue activado;
- cada conexión te pide su contraseña la próxima vez que conectes.

HuginnDB muestra esa misma pantalla si falta el fichero de la bóveda o está
dañado.

## Cambiar la contraseña o desactivar el bloqueo

En **Ajustes → Seguridad**:

- **Cambiar la contraseña maestra…** pide la contraseña actual y una nueva.
  Tus secretos no cambian.
- **Desactivar…** pide la contraseña maestra y devuelve todos los secretos al
  llavero del sistema, tal como estaban.

## En un equipo gestionado

La política de HuginnDB de tu organización puede exigir el bloqueo, limitar el
tiempo que HuginnDB puede estar sin usarse y decidir si se bloquea con tu
sesión. Esos ajustes muestran entonces quién los decide, y HuginnDB los aplica
aunque la interfaz te dejara cambiarlos. Consulta [Política gestionada](POLICY.es.md).

## Relacionado

- [Conexiones](CONNECTIONS.es.md): cómo se guardan las contraseñas con el
  bloqueo desactivado.
- [Conector MCP](MCP.es.md): a qué puede llegar el conector.
