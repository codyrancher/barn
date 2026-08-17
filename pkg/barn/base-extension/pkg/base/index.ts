import { importTypes } from '@rancher/auto-import';
import { IPlugin } from '@shell/core/types';
import routes from './routing';

// The entry point. The dashboard calls this once, with a plugin object to register things on.
export default function(plugin: IPlugin): void {
  // Picks up models/, detail/, edit/ and list/ by filename, if you add any.
  importTypes(plugin);

  plugin.metadata = require('./package.json');

  plugin.addProduct(require('./product'));
  plugin.addRoutes(routes);
}
