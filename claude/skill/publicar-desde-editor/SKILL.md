---
name: publicar-desde-editor
description: Publica como borrador en WordPress (vía WPVibe) lo que se ha enviado desde el artefacto «Editor Blogpocket para Claude». Úsala con «publica lo del editor» o similar.
---

# Publicar desde el Editor Blogpocket para Claude

El usuario escribe sus posts en un artefacto de Claude llamado **Editor Blogpocket para Claude**. Al pulsar **Enviar**, el editor guarda en el borrador todo lo necesario para publicarlo: tipo, imagen, colocación, sitio y notas. Esta skill lee ese envío y crea un **borrador** en WordPress con el conector WPVibe.

## Reglas

- **Siempre en borrador** (`status: "draft"`). Nunca publiques.
- **El texto es del usuario.** Respétalo palabra por palabra: solo lo conviertes a bloques. Si ves una errata, menciónala al final y no la corrijas sin permiso.
- **No toques el texto del editor** (`content`). Solo escribes en el campo `envio`.
- **Las notas del envío mandan** sobre lo que decidirías tú (categoría, etiquetas, frase clave…).
- **Aprobaciones de WPVibe:** cuando una operación pida aprobación, muestra el panel en la conversación (`show_approval_panel`).
- **Si algo falla**, para, marca el envío como `error` (Paso 6) y explica qué pasó.

## Datos del editor

El artefacto guarda sus datos en su base de datos (herramientas `db_list`, `db_get` y `db_write` del conector de artefactos):

- Colección `drafts`, un documento por borrador:
  - `content`: Markdown. La primera línea `# …` es el título.
  - `updated`, `created`: marcas de tiempo en milisegundos.
  - `envio`:
    - `estado`: `pendiente` (lo pone el editor), `publicando`, `borrador_wp` o `error` (los pones tú).
    - `tipo`: `entrada` o `pagina`.
    - `sitio`: URL completa del WordPress, por ejemplo `https://tublog.com`.
    - `imagen`: `null` o `{id, nombre, tipo, ancho, alto, bytes}`. `id` es un recurso (asset) del artefacto.
    - `posicion`: con imagen, `izquierda`, `derecha`, `encima` o `destacada`.
    - `notas`: indicaciones libres del usuario.
    - `enviado`, `wpId`, `wpUrl`, `editUrl`, `mensaje`.
- Documento `config/sitios`: `{sitios: [...]}`, los sitios que el usuario configuró en Ajustes.

## Paso 1: Encontrar el envío

1. Busca el artefacto con `list_artifacts` (`query: "Editor Blogpocket para Claude"`). Si hay más de uno, pregunta cuál.
2. `db_list` de la colección `drafts`. Quédate con los documentos cuyo `envio.estado` sea `pendiente`. La consulta con `where` no sirve aquí porque solo filtra campos de primer nivel.
3. Si hay uno, ese es. Si hay varios, pregunta por título. Si no hay ninguno, dilo y ofrece publicar el último editado.
4. El texto que vale es el `content` actual, aunque el usuario lo haya cambiado después de enviar.
5. Marca el envío: `db_write` con `op: "update"` en `drafts/<id>`, `data: {"envio": {"estado": "publicando"}}` y el `ifVersion` de la lectura.

## Paso 2: Preparar WordPress

1. `site_info` sobre `envio.sitio`. Si el sitio no está conectado a WPVibe, pide al usuario que lo conecte (`connect_site`) y para hasta que lo haga.
2. Anota el plugin de SEO activo (Yoast, Rank Math u otro) y si el editor es de bloques.
3. Carga la ayuda de bloques de WPVibe: `load_skill({ query: "gutenberg blocks post" })`.

## Paso 3: La imagen

Si `envio.imagen` no es `null`:

1. Mírala con `read_asset` (slug del artefacto, `id` de la imagen, `max_bytes: 4194304`). Escribe el ALT a partir de lo que ves, no del título del post.
2. WordPress no puede descargarla del artefacto: es privada y la API REST no sube archivos. Lanza `request_upload` (panel en la conversación) y pide al usuario que suelte ese mismo archivo (`imagen.nombre`). Sondea `check_upload` hasta que esté listo.
3. Sube la URL provisional con `upload_media` (`site_url`, `url`, `title`, `alt_text`):
   - Con `posicion: "destacada"`, crea primero el borrador (Paso 5) y llama a `upload_media` con su `post_id`. No la metas en el cuerpo.
   - En las demás posiciones, sin `post_id`. Guarda el ID del medio y el bloque de imagen que devuelve la herramienta.
4. Pide `GET /wp/v2/media/<id>?_fields=id,media_details` y toma `media_details.sizes.large.source_url`. Si no existe `large`, usa `full`.

## Paso 4: Metadatos

- **Título:** la línea `# …` del texto. No la repitas en el cuerpo.
- **Frase clave:** de 2 a 4 palabras que aparezcan tal cual en el texto, a ser posible en el primer párrafo.
- **Slug:** corto, en minúsculas, con la frase clave.
- **Extracto** (solo entradas): una o dos frases, unos 150 caracteres, con la frase clave.
- **Categoría y etiquetas** (solo entradas): usa las que ya existen (`GET /wp/v2/categories?per_page=100` y `GET /wp/v2/tags?search=…`). Una categoría y de 3 a 6 etiquetas. Crea una etiqueta nueva solo si no hay ninguna equivalente. Nunca crees categorías.
- **SEO:** título SEO de unos 60 caracteres y meta descripción de unos 150, con la frase clave.

Escribe frases directas, en voz activa y sin relleno.

## Paso 5: Bloques y borrador

Convierte el Markdown a bloques con un script de Python, nunca a mano:

| Markdown | Bloque |
|---|---|
| `## Subtítulo` | `<!-- wp:heading -->` `<h2 class="wp-block-heading">…</h2>` `<!-- /wp:heading -->` |
| `### Subtítulo` | `<!-- wp:heading {"level":3} -->` `<h3 class="wp-block-heading">…</h3>` `<!-- /wp:heading -->` |
| `#### Subtítulo` | `<!-- wp:heading {"level":4} -->` `<h4 class="wp-block-heading">…</h4>` `<!-- /wp:heading -->` |
| Párrafo | `<!-- wp:paragraph -->` `<p>…</p>` `<!-- /wp:paragraph -->` |
| `**negrita**`, `*cursiva*`, `~~tachado~~`, `` `código` `` | `<strong>`, `<em>`, `<s>`, `<code>` |
| `[texto](url)` | `<a href="url">texto</a>` |
| `- elemento` / `1. elemento` | `wp:list` con un `wp:list-item` por elemento (`{"ordered":true}` y `<ol>` si es numerada) |
| `> cita` | `<!-- wp:quote -->` `<blockquote class="wp-block-quote">` con párrafos dentro `</blockquote>` `<!-- /wp:quote -->` |
| Bloque de código | `<!-- wp:code -->` `<pre class="wp-block-code"><code>…</code></pre>` `<!-- /wp:code -->` |
| `---` | `<!-- wp:separator -->` `<hr class="wp-block-separator has-alpha-channel-opacity"/>` `<!-- /wp:separator -->` |
| Tabla | `<!-- wp:table -->` `<figure class="wp-block-table"><table>…</table></figure>` `<!-- /wp:table -->` |
| Notas al pie `[^1]` | Superíndice con enlace a una lista final de notas tras un separador |

Escapa `&`, `<` y `>` antes de aplicar el formato en línea.

**Colocación de la imagen:**

- `izquierda` / `derecha`: mete la imagen y **todo** el texto dentro de un Grupo con diseño por defecto. Sin el grupo, muchos temas de bloques no dejan que el texto rodee la imagen. Para `derecha`, cambia `left` por `right` en el atributo y en la clase:

  ```
  <!-- wp:group {"layout":{"type":"default"}} -->
  <div class="wp-block-group"><!-- wp:image {"lightbox":{"enabled":true},"id":<ID>,"width":"300px","height":"auto","sizeSlug":"large","linkDestination":"none","align":"left"} -->
  <figure class="wp-block-image alignleft size-large is-resized"><img src="<URL_LARGE>" alt="<ALT>" class="wp-image-<ID>" style="width:300px;height:auto"/></figure>
  <!-- /wp:image -->

  …bloques del texto…</div>
  <!-- /wp:group -->
  ```

  Copia el marcado tal cual: si el atributo, las clases y el `style` no coinciden, el editor marca el bloque como no válido.
- `encima`: pega primero el bloque de imagen que devolvió `upload_media`, sin tocarlo, y después los bloques del texto.
- `destacada`: no va en el cuerpo (Paso 3).

**Crear el borrador:** genera el cuerpo con `json.dumps(..., ensure_ascii=False)` y pásalo tal cual a `rest_api`:

- Entrada: `POST /wp/v2/posts` con `{title, slug, status: "draft", excerpt, categories, tags, content}`.
- Página: `POST /wp/v2/pages` con `{title, slug, status: "draft", content}`.
- `fields: "id,link,status"`. Si la respuesta trae errores de validación de bloques, corrige el marcado y vuelve a guardar.

**SEO:**

- Yoast: `run_wp_cli` con `post meta update <id> _yoast_wpseo_focuskw "<frase>" --force`, y lo mismo con `_yoast_wpseo_title` y `_yoast_wpseo_metadesc`. Un comando por clave.
- Rank Math: `post meta update <id> rank_math_focus_keyword "<frase>"`, y lo mismo con `rank_math_title` y `rank_math_description`.
- Otro plugin o ninguno: no escribas nada y dilo en el resumen.

## Paso 6: Cerrar el envío

1. `db_get` de `drafts/<id>` para obtener la versión. Después, `db_write` con `op: "update"` y:
   `{"envio": {"estado": "borrador_wp", "wpId": <id>, "wpUrl": "<sitio>/?p=<id>&preview=true", "editUrl": "<sitio>/wp-admin/post.php?post=<id>&action=edit", "mensaje": null}}`
   El editor mostrará «En WordPress como borrador» con enlace a la edición.
2. Si paraste por un error: `{"envio": {"estado": "error", "mensaje": "<qué pasó, en una frase>"}}`.
3. Comprueba el borrador con `GET /wp/v2/<posts|pages>/<id>?context=edit` (`fields: "id,status,content.raw"`).
4. Entrega al usuario el enlace de edición, la vista previa y un resumen corto: título, slug, frase clave, categoría y etiquetas, SEO y ALT. Añade las erratas que hayas visto.
