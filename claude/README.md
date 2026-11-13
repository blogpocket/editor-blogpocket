# Editor Blogpocket para Claude

Esta versión del editor vive dentro de Claude, como artefacto. Escribes el post en el panel lateral, pulsas **Enviar** y le dices a Claude «Publica lo del editor». Claude lee el texto, convierte el Markdown en bloques de WordPress, rellena título, extracto, categoría, etiquetas y SEO, y deja el post como borrador en tu sitio.

Es la misma app que el editor de la carpeta principal: Markdown visible con estilo, barra flotante, títulos, listas, tablas, notas al pie y vista previa. Cambian el almacenamiento y el botón de envío.

## Qué hay en esta carpeta

| Ruta | Qué es |
|---|---|
| `editor/` | Los tres archivos del artefacto: `index.html`, `app.js` y `styles.css` |
| `skill/publicar-desde-editor.zip` | La skill que Claude usa para publicar lo que envías |
| `skill/publicar-desde-editor/SKILL.md` | El contenido de la skill, por si quieres leerla o adaptarla |

## Qué necesitas

- Una cuenta de Claude con artefactos y skills.
- **Crear y editar archivos** activado en **Configuración > Capacidades**. Los artefactos y las skills dependen de ese ajuste.
- El conector **WPVibe** añadido a Claude y tu WordPress conectado a él.

## Instalación

### 1. Crea tu editor

Descarga los tres archivos de `editor/`, adjúntalos en una conversación con Claude y pídele:

> Publica estos tres archivos como artefacto con el título «Editor Blogpocket para Claude». Después declara estas capacidades: `{"db":{"rules":[{"path":"","read":"owner","write":"owner"}]},"user":{},"assets":{}}`

El título importa: la skill busca el editor por ese nombre.

La regla de `db` hace que solo tú puedas leer y escribir los borradores, aunque algún día compartas el enlace del artefacto. `assets` permite subir imágenes y `user` identifica a quien abre el editor.

### 2. Añade tu sitio

Abre el artefacto, entra en **Ajustes** (el icono de los deslizadores) y pulsa **Editar…** en «Sitios de WordPress». Escribe la dirección de tu blog, una por línea si tienes varios. El primero sale marcado al enviar.

### 3. Instala la skill

En Claude, ve a **Personalizar > Habilidades**, pulsa **+**, después **Crear habilidad** y **Cargar una habilidad**, y elige `publicar-desde-editor.zip`.

## Cómo se usa

1. Escribe el post. La primera línea con `#` es el título. El texto se guarda solo.
2. Pulsa **Enviar** y elige:
   - entrada o página,
   - una imagen (opcional),
   - su colocación: flotando a la izquierda, flotando a la derecha, encima del texto o solo como imagen destacada,
   - el sitio,
   - y, si quieres, notas para Claude: categoría, etiquetas o frase clave.
3. Escribe en el chat **Publica lo del editor**.
4. Cuando Claude termina, la barra inferior del editor muestra «En WordPress como borrador» con un enlace a la edición. Revisa el borrador y publícalo tú.

## Límites

- **La imagen se sube dos veces.** Claude la ve en el editor para escribir el texto alternativo y decidir dónde va. Pero WordPress solo admite imágenes que pueda descargar desde una dirección pública, y las del artefacto son privadas. Al publicar, Claude te mostrará el panel de subida de WPVibe y tendrás que soltar ahí el mismo archivo.
- **Sin descargas.** Los artefactos no permiten descargar archivos, así que esta versión no exporta `.md` ni `.html`. Puedes copiar el Markdown o el HTML.
- **Tus borradores de la versión web no se copian solos.** Haz una copia de seguridad en el editor de tu hosting y ábrela aquí con **Exportar > Importar copia del editor…**.
- **Probado con temas de bloques.** Si en tu tema el texto no rodea la imagen flotante, díselo a Claude: el ajuste suele estar en el bloque Grupo que la envuelve.

## Privacidad

Los borradores y las imágenes viven en la base de datos del artefacto, dentro de tu cuenta de Claude. El editor no envía nada a ningún otro sitio. Las librerías `marked`, `marked-footnote` y `DOMPurify` se cargan desde jsDelivr.

## Licencia

MIT, como el resto del repositorio.
