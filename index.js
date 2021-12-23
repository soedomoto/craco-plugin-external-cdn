const path = require("path");
const defaultResolver = require("module-to-cdn");
const ExternalModule = require("webpack/lib/ExternalModule");
const semver = require('semver');

const pluginName = 'cdn-webpack-plugin';
const moduleRegex = /^((?:@[a-z0-9][\w-.]+\/)?[a-z0-9][\w-.]*)/;

const getEnvironment = mode => {
  switch (mode) {
    case 'none':
    case 'development':
      return 'development';

    default:
      return 'production';
  }
};

class ExternalCdnPlugin {
  constructor({ disable = false, env, exclude, only, verbose, resolver, htmlWebpackPlugin } = {}) {
    if (exclude && only) {
      throw new Error('You can\'t use \'exclude\' and \'only\' at the same time');
    }

    this.disable = disable;
    this.env = env;
    this.exclude = exclude || [];
    this.only = only || null;
    this.verbose = verbose === true;
    this.resolver = (modulePath, version, { env }) => {
      return defaultResolver(modulePath, version, { env }) ||
        resolver(modulePath, version, { env });
    };
    this.htmlWebpackPlugin = htmlWebpackPlugin;

    this.allModules = {};
    this.modulesFromCdn = {};
  }

  apply(compiler) {
    if (!this.disable) {
      this.execute(compiler, { env: this.env || getEnvironment(compiler.options.mode) });
    }
  }

  execute(compiler, { env }) {
    compiler.hooks.compile.tap(pluginName, ({ normalModuleFactory }) => {
      normalModuleFactory.hooks.factorize.tapAsync(pluginName, (data, callback) => {
        const context = data.context;
        const dependency = data.dependencies[0];

        const modulePath = dependency.request;
        const isModulePath = moduleRegex.test(modulePath);
        if (isModulePath) {
          const module = this.addModule(context, modulePath, { env });
          if (module) {
            if (['js', 'javascript'].includes((module.type || 'js').toLowerCase())) {
              callback(null, new ExternalModule(module.var, 'var', modulePath));
            } else {
              // we still dont have any way to externalize css
              // callback(null, new ExternalModule(module.var, 'var', modulePath));
              callback(null);
            }

            return;
          }
        }

        callback();
      });
    });

    compiler.hooks.compilation.tap(pluginName, compilation => {
      this.htmlWebpackPlugin.getHooks(compilation).alterAssetTags.tap(pluginName, data => {
        data.assetTags.scripts = [
          ...Object.keys(this.modulesFromCdn)
            .filter(module => (
              ['js', 'javascript'].includes((this.modulesFromCdn[module].type || 'js').toLowerCase())
            ))
            .map(module => (
              this.generateScriptTag({ src: this.modulesFromCdn[module].url })
            )),
          ...data.assetTags.scripts,
        ];

        data.assetTags.styles = [
          ...Object.keys(this.modulesFromCdn)
            .filter(module => (
              ['css', 'stylesheet'].includes((this.modulesFromCdn[module].type || 'js').toLowerCase())
            ))
            .map(module => (
              this.generateStyleTag({ href: this.modulesFromCdn[module].url })
            )),
          ...data.assetTags.styles,
        ];

        return data;
      });
    });
  }

  generateScriptTag({ defer = 'defer', type = undefined, src }) {
    return {
      tagName: 'script',
      voidTag: false,
      meta: { plugin: 'html-webpack-plugin' },
      attributes: { defer, type, src }
    }
  }

  generateStyleTag = ({ href }) => {
    return {
      tagName: 'link',
      voidTag: true,
      meta: { plugin: 'html-webpack-plugin' },
      attributes: { href, rel: 'stylesheet' }
    };
  }

  addModule(contextPath, modulePath, { env }) {
    const isModuleExcluded = this.exclude.includes(modulePath) || this.only && !this.only.includes(modulePath);
    if (isModuleExcluded) {
      return false;
    }

    try {
      const moduleName = modulePath.match(moduleRegex)[1];
      const packageJsonPath = require.resolve(path.join(moduleName, "package.json"), { paths: [contextPath] });
      const { version, peerDependencies } = require(packageJsonPath);

      const isModuleAlreadyLoaded = Boolean(this.modulesFromCdn[modulePath]);
      if (isModuleAlreadyLoaded) {
        const isSameVersion = this.modulesFromCdn[modulePath].version === version;
        if (isSameVersion) {
          return this.modulesFromCdn[modulePath];
        }
        return false;
      }

      const cdnConfig = this.resolver(modulePath, version, { env });
      if (cdnConfig == null) {
        // if (this.verbose) {
        //   console.log(`❌ '${modulePath}' couldn't be externalized`);
        // }
        return false;
      }

      if (this.verbose) {
        console.log(`✔️ '${cdnConfig.name}' will be served by ${cdnConfig.url}`);
      }

      if (peerDependencies) {
        const arePeerDependenciesLoaded = Object.keys(peerDependencies)
          .map(peerDependencyName => {
            return this.addModule(contextPath, peerDependencyName, { env });
          })
          .map(x => Boolean(x))
          .reduce((result, x) => result && x, true);

        if (!arePeerDependenciesLoaded) {
          return false;
        }
      }

      this.modulesFromCdn[modulePath] = cdnConfig;

      return cdnConfig;
    } catch (err) {
      return false;
    }
  }
}

const resolver = (moduleName, version, options) => {
  const modules = {
    "antd": {
      "var": "antd",
      "versions": {
        "*": {
          "development": `https://unpkg.com/antd@${version}/dist/antd.js`,
          "production": `https://unpkg.com/antd@${version}/dist/antd.min.js`
        }
      }
    },
    "antd/dist/antd.variable.min.css": {
      "type": "css",
      "var": "antd/dist/antd.variable.min.css",
      "versions": {
        "*": {
          "development": `https://unpkg.com/antd@${version}/dist/antd.variable.css`,
          "production": `https://unpkg.com/antd@${version}/dist/antd.variable.min.css`
        }
      }
    },
    "antd/dist/antd.variable.css": {
      "type": "css",
      "var": "antd/dist/antd.variable.css",
      "versions": {
        "*": {
          "development": `https://unpkg.com/antd@${version}/dist/antd.variable.css`,
          "production": `https://unpkg.com/antd@${version}/dist/antd.variable.min.css`
        }
      }
    },
  };

  options = options || {};
  const env = options.env || 'development';

  if (typeof moduleName !== 'string') {
    throw new TypeError('Expected \'moduleName\' to be a string');
  }

  if (typeof version !== 'string') {
    throw new TypeError('Expected \'version\' to be a string');
  }

  const isModuleAvailable = moduleName in modules;
  if (!isModuleAvailable) {
    return null;
  }

  const range = Object.keys(modules[moduleName].versions)
    .find(range => semver.satisfies(version, range));
  const config = modules[moduleName].versions[range];

  if (config == null) {
    return null;
  }

  let url = env === 'development' ? config.development : config.production;
  if (url == null) {
    return null;
  }

  return {
    name: moduleName,
    var: modules[moduleName].var,
    url,
    version,
    type: modules[moduleName].type || 'js',
  };
}

module.exports = {
  overrideWebpackConfig: ({ webpackConfig, cracoConfig, pluginOptions, context: { env, paths } }) => {
    const originInterpolatePlugin = webpackConfig.plugins.find(
      d => d.replacements && d.replacements.NODE_ENV
    );

    if (!originInterpolatePlugin) {
      console.warn('Could not find react-dev-utils/InterpolateHtmlPlugin.');
      return;
    }

    webpackConfig.plugins.push(
      new ExternalCdnPlugin({
        verbose: true,
        resolver: resolver,
        htmlWebpackPlugin: originInterpolatePlugin.htmlWebpackPlugin
      })
    );

    webpackConfig.optimization = {
      splitChunks: {
        chunks: 'all',
      },
    };

    return webpackConfig;
  }
};
