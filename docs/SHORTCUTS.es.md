# Atajos de teclado

HuginnDB está pensado para manejarse con el teclado. Cada comando que sabe
ejecutar vive en un único catálogo, y cada entrada de ese catálogo puede
llevar una tecla — o varias, o ninguna.

Preferencias → Atajos es donde se hace.

## De qué se compone un atajo

Un **acorde** es una pulsación con sus modificadores: `Mod+K`, `Shift+F5`,
`Space`.

Una **secuencia** son dos acordes seguidos, separados por un espacio:
`Mod+K Mod+S`. Pulsas el primero y HuginnDB espera — la barra de estado
muestra qué está esperando — hasta que pulses el segundo o pasen dos segundos.
Ningún atajo viene de fábrica como secuencia; existen para que tengas dónde
poner los comandos que ya no caben en una sola combinación.

`Mod` es el modificador que realmente pulsas: `Ctrl` en Windows y Linux, `⌘`
en macOS. Se guarda como `Mod` y se dibuja con el símbolo que corresponda a tu
plataforma. `Ctrl` y `Meta` también existen como tokens exactos si quieres
específicamente la tecla Control o Command real.

## Una acción, varias teclas

Una acción puede tener más de un atajo. El primero es el **principal** — el
que muestran los menús, la paleta de comandos y los tooltips. El resto son
alias que funcionan igual de bien.

Haz clic en una tecla para grabar otra, en su `×` para quitarla, o en `+` para
añadir una más. Una acción sin ninguna está sin asignar, que es un estado
perfectamente válido y con el que sale casi todo el catálogo: estar en la
lista ya la hace buscable y vinculable sin gastar una tecla en ella.

## Dónde se oye un atajo

Cada acción tiene un **ámbito**, visible en su fila:

| Ámbito | Se oye cuando |
| --- | --- |
| `global` | En cualquier parte de la app. |
| `editor` | El foco está en un editor de SQL, vista o pipeline. |
| `grid` | El foco está en la rejilla de datos. |
| `tree` | El foco está en el árbol de esquema. |
| `overlay` | Hay una paleta o un diálogo abiertos. |

Esto es lo que permite que dos acciones compartan tecla sin ambigüedad: un
atajo en `grid` y otro en `editor` nunca son audibles a la vez, así que ambos
están permitidos. Dos atajos chocan solo cuando sus ámbitos se solapan — un
ámbito se solapa consigo mismo y con `global`.

Cuando la tecla que estás grabando sí choca, el diálogo dice qué acción la
tiene y ofrece quitársela.

**Dentro de un terminal**, el teclado es del terminal: el `Ctrl+R`, `Ctrl+K` o
`Ctrl+B` de un shell no deben abrir ni cerrar un panel. Allí solo se oyen la
paleta de comandos, Preferencias y los conmutadores de Consola / Terminal.

## Teclas que la app se reserva

`Mod+R` siempre refresca, además de lo que le asignes a esa acción. No se
puede reasignar ni quitar: existe para impedir que el webview recargue la app
entera — y se lleve tu sesión por delante — cuando recurres al reflejo del
navegador. Las teclas reservadas se muestran atenuadas en su fila en vez de
esconderse, para que no sean una sorpresa.

## Escribir sigue teniendo prioridad

Un atajo que no se distinguiría de escribir — sin `Mod`, `Ctrl`, `Meta` ni
`Alt`, y con una tecla imprimible — no se dispara mientras el cursor está en
un campo de texto. Asigna una acción a `A` y `A` seguirá escribiendo una `A`
en el diálogo de conexión.

Las teclas que no producen carácter no se ven afectadas: `F5`, `Escape` y las
flechas funcionan esté donde esté el foco.

## Encontrar un atajo

El buscador filtra por nombre de acción. El chip **Por tecla** lo convierte en
un capturador: pulsas una combinación y la lista se reduce a quien la usa. Es
la forma de responder «¿qué hace esta tecla?» y «¿está libre?» antes de
asignar nada.

**Modificados** deja solo lo que has cambiado. El botón de restablecer de una
fila devuelve esa acción a su valor por defecto; **Restablecer todos** borra
todas las personalizaciones de golpe y pregunta antes, porque no hay deshacer.

## Llevarlos de una máquina a otra

**Exportar** escribe tus personalizaciones en un archivo JSON; **Importar**
sustituye el conjunto actual por el de un archivo.

Solo viajan tus *overrides*, no los atajos resueltos. Exportar lo que cada
acción hace ahora mismo grabaría los valores por defecto de esta versión en el
archivo, así que importarlo en una versión más nueva te dejaría anclado al
catálogo de ayer y te sacaría en silencio de cada valor por defecto añadido
desde entonces. Si un archivo nombra una acción que esta versión no conoce, la
importación lo dice en vez de descartarla en silencio.

## Dónde se guarda

En `prefs.json`, en el directorio de configuración de HuginnDB, bajo
`keybindings` — un mapa de id de acción a lista de atajos. Tres estados, los
tres con significado:

- **clave ausente** — esa acción usa su valor por defecto
- **`[]`** — la desasignaste a propósito
- **`["Mod+Enter", "F9"]`** — principal primero, luego los alias

Un mapa vacío es el estado completamente por defecto, y por eso «Restablecer
todos» lo vacía en vez de escribir cada valor por defecto dentro de él.
