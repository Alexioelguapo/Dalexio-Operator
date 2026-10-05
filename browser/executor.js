class BrowserExecutor {
  constructor(controller) {
    this.controller = controller;
  }

  async execute(command) {
    if (!command || !command.action) {
      throw new Error('Command must contain an action.');
    }

    switch (command.action) {
      case 'navigate':
        if (!command.url) throw new Error('navigate requires url');
        return this.controller.navigate(command.url);

      case 'observe':
        return this.controller.observe();

      case 'click_ref':
        if (!command.ref) throw new Error('click_ref requires ref');
        return this.controller.clickRef(command.ref);

      case 'type_ref':
        if (!command.ref) throw new Error('type_ref requires ref');
        if (typeof command.text !== 'string') {
          throw new Error('type_ref requires text');
        }
        return this.controller.typeRef(command.ref, command.text);

      case 'read':
        return {
          text: await this.controller.readText(command.selector || 'body')
        };

      case 'click':
        if (!command.selector) throw new Error('click requires selector');
        return this.controller.click(command.selector);

      case 'type':
        if (!command.selector) throw new Error('type requires selector');
        if (typeof command.text !== 'string') {
          throw new Error('type requires text');
        }
        return this.controller.type(command.selector, command.text);

      case 'screenshot':
        return {
          path: await this.controller.screenshot(
            command.path || 'browser-state.png'
          )
        };

      case 'state':
        return this.controller.getState();

      default:
        throw new Error(`Unknown action: ${command.action}`);
    }
  }
}

module.exports = BrowserExecutor;
