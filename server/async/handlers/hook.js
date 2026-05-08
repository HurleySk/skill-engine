'use strict';

const hooks = new Map();

module.exports = {
  name: 'hook',

  validate(config) {
    const name = config && config.hookName;
    if (name && !hooks.has(name)) {
      return ['Unknown async hook: ' + name + '. Available: ' + Array.from(hooks.keys()).join(', ')];
    }
    return [];
  },

  async execute(job) {
    const { name, config, context } = job;
    const hookFn = hooks.get(name);
    if (!hookFn) return [];
    try {
      const result = await Promise.resolve(hookFn(context, config || {}));
      return Array.isArray(result) ? result : [];
    } catch {
      return [];
    }
  },

  registerHook(name, fn) {
    hooks.set(name, fn);
  },

  listHooks() {
    return Array.from(hooks.keys());
  },

  _clearHooks() {
    hooks.clear();
  },
};
