import type { EditorPlugin } from "../core/plugin";
import { checkPlugins, checksPanelPlugin } from "./checks";
import { commentsPlugin } from "./comments";
import { coreCommands } from "./core-commands";
import { exportChannelsPlugin } from "./export-channels";
import { captionsTabPlugin } from "./inspector-captions";
import { contentTabPlugin } from "./inspector-content";
import { motionTabPlugin } from "./inspector-motion";
import { shotsTabPlugin } from "./inspector-shots";
import { lookPlugin } from "./look";
import { mediaPlugin } from "./media";
import { overlaysPlugin } from "./overlays";
import { pluginsPanelPlugin } from "./plugins-panel";
import { scenesPlugin } from "./scenes";
import { tracksPlugin } from "./tracks";

/**
 * Every built-in plugin, in the order the plugin list shows them. A new feature is a new file here:
 * `definePlugin({ id, name, description, panels / inspector / tracks / markers / overlays / checks /
 * commands / mediaSources / exporters })`, then one line in this array.
 */
export const BUILTIN_PLUGINS: EditorPlugin[] = [
  coreCommands,
  scenesPlugin,
  contentTabPlugin,
  shotsTabPlugin,
  captionsTabPlugin,
  motionTabPlugin,
  mediaPlugin,
  lookPlugin,
  checksPanelPlugin,
  ...checkPlugins,
  commentsPlugin,
  tracksPlugin,
  overlaysPlugin,
  exportChannelsPlugin,
  pluginsPanelPlugin,
];
