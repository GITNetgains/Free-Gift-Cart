// Self-hosted TinyMCE bundle for the admin's HTML editor. Skins and content
// styles are imported as JS resources so nothing is fetched from a CDN.
import "tinymce/tinymce";
import "tinymce/models/dom/model";
import "tinymce/themes/silver/theme";
import "tinymce/icons/default/icons";
import "tinymce/skins/ui/oxide/skin.js";
import "tinymce/skins/ui/oxide/content.js";
import "tinymce/skins/content/default/content.js";
import "tinymce/plugins/autolink";
import "tinymce/plugins/code";
import "tinymce/plugins/image";
import "tinymce/plugins/link";
import "tinymce/plugins/lists";
import "tinymce/plugins/media";
import "tinymce/plugins/table";
