# Documentación de HuginnDB

> Nota: este archivo es la traducción al español de `README.md` (el de esta
> carpeta). Si ves algo desactualizado respecto al original en inglés, ese es el
> que manda.

Guías de uso de la app. Todo lo de aquí se puede leer también **dentro de
HuginnDB**, en **Ayuda → Documentación**, que empaqueta estos ficheros al
compilar —sin necesidad de red— y muestra la fecha de última actualización de
cada uno.

Cada guía tiene su gemela en español (`<NOMBRE>.es.md`). El inglés es el
original; una traducción puede quedarse atrás, y el visor de la app cae al inglés
para cualquier idioma que no tenga traducción.

| Guía | Qué cubre |
| --- | --- |
| [Conexiones](CONNECTIONS.es.md) · [en](CONNECTIONS.md) | Crear conexiones por driver, SSL, túneles SSH, dónde viven las contraseñas, conexiones a todo un servidor, límites de pools, keepalive, los flags de la CLI, exportar/importar y orígenes compartidos. |
| [Entornos](ENVIRONMENTS.es.md) · [en](ENVIRONMENTS.md) | Conjuntos de trabajo con nombre: qué conexiones están en juego, qué pestañas y disposición vuelven, y qué *no* posee un entorno. |
| [Esquemas JSON](JSON_SCHEMAS.es.md) · [en](JSON_SCHEMAS.md) | Vincular un esquema JSON a una columna para autocompletado, documentación al pasar el ratón y validación orientativa: la biblioteca, la cascada de más-específico-gana, redactar uno a partir de un valor y compartir. |
| [MongoDB](MONGODB.es.md) · [en](MONGODB.md) | El dialecto `mongosh` del editor, el editor de documentos, pipelines de agregación y vistas, el gestor de índices, renombrar/mover una colección y lo que no hay. |
| [SQL Server](SQL_SERVER.es.md) · [en](SQL_SERVER.md) | `HOST\INSTANCIA` y el SQL Browser, confianza en el certificado, autenticación de Windows, cómo llegan los valores y las superficies aún sin implementar. |
| [Conector MCP](MCP.es.md) · [en](MCP.md) | Exponer tus bases de datos a un cliente de IA: el binario, la configuración por cliente, el nivel de escritura por conexión, el log de auditoría y qué hacer cuando el bloqueo viene del propio cliente. |
| [Panel de IA](AI.es.md) · [en](AI.md) | Hablar con un modelo de lenguaje sobre tu base de datos: local primero, solo lectura y desactivado por defecto, a qué endpoint se conecta y qué datos puede ver. |
| [Política gestionada](POLICY.es.md) · [en](POLICY.md) | Una sola política que leen todas las instalaciones de una organización: qué puede ver y hacer la IA, por rol y por base de datos. |
| [Pulse](PULSE.es.md) · [en](PULSE.md) | Salud y rendimiento del servidor en vivo y su historial: constantes vitales, sentencias costosas y retrospectiva (MySQL y MongoDB). |
| [Atajos de teclado](SHORTCUTS.es.md) · [en](SHORTCUTS.md) | El catálogo de comandos y cómo asignar, cambiar o quitar la tecla de cada uno desde Preferencias → Atajos. |

Documentos a nivel de repositorio, fuera de esta carpeta (en inglés):
[`README.md`](../README.md), [`ROADMAP.md`](../ROADMAP.md),
[`CHANGELOG.md`](../CHANGELOG.md), [`SECURITY.md`](../SECURITY.md),
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Notas internas

Razonamiento de diseño y seguimiento de trabajo, no documentación de usuario —
quedan fuera del visor de la app a propósito. Están todas en inglés:

| Documento | Para qué |
| --- | --- |
| [`MCP_CONNECTOR_ROADMAP.md`](MCP_CONNECTOR_ROADMAP.md) | Por qué el conector MCP es un sidecar headless sobre stdio, fase a fase, más la cuestión abierta de distribuirlo por un marketplace. |
| [`MONGODB_ROADMAP.md`](MONGODB_ROADMAP.md) | El reparto completo de hecho/diferido del driver de MongoDB, con el punto de enganche de cada punto abierto. |
| [`CONNECTION_POOLING_ANALYSIS.md`](CONNECTION_POOLING_ANALYSIS.md) | Cómo se acotó la huella de conexiones: presupuestos por servidor, pools hijos, el reaper. |
| [`CANARY.md`](CANARY.md) | El canal de pre-lanzamiento en paralelo: qué aísla, qué comparte y cómo se compila. |

## Añadir una guía

1. Escribe `docs/<NOMBRE>.md` (e idealmente `docs/<NOMBRE>.es.md`).
2. Añade sus importaciones `?raw` y una entrada en `src/lib/appInfo/docs.ts`.
3. Añade `docs.entries.<id>.title` / `.description` a
   `src/lib/i18n/locales/en.json` y `es.json`.
4. Añade la ruta del fichero en inglés a `DOC_FILES` en `vite.config.ts`, para
   que se inyecte su fecha de última actualización.
5. Enlázala en la tabla de arriba.

Ceñíos a lo que soporta el renderizador de la app: encabezados, párrafos, bloques
de código, tablas GFM con pipes, listas sin anidar, citas, reglas y
código/negrita/cursiva/enlaces en línea. No es un motor CommonMark completo.

De cómo el visor presenta una guía se derivan dos cosas. **Cada `##` es una
página**: el visor saca su navegación de los encabezados, muestra la prosa
anterior al primer `##` como portada y luego una página por `##`, con cada `###`
como destino de salto dentro de ella. Así que un `##` es una unidad a la que un
lector puede llegar en frío: que ninguno dependa de haberse leído el anterior.

**Los enlaces resuelven, con límites.** Los `http(s)` abren en el navegador del
sistema. Un `#ancla` salta a ese encabezado dentro de la misma guía, y un enlace
relativo a otra guía de la tabla de arriba cambia a ella. Un enlace a algo fuera
de ese conjunto — una hoja de ruta, `../SECURITY.md` — abre en GitHub. Un
`#ancla` cuyo encabezado ya no existe se renderiza como texto plano sin color y
no hace nada, y eso hace fallar a `docOutline.test.ts`, así que un encabezado que
renombres se lleva por delante los enlaces que apuntaban a él.
