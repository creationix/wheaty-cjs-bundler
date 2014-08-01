"use strict";

var pathJoin = require('path').join;
var mine = require('mine');
var modes = require('js-git/lib/modes');

// This function is run on the remote side.  Here it's simply
// stringified and sent as part of the bundle.
function wrapper(main, defs) {
  var modules = {};
  require(main);
  function require(filename) {
    var module = modules[filename];
    if (module) return module.exports;
    module = modules[filename] = {exports:{}};
    var dirname = filename.substring(0, filename.lastIndexOf("/"));
    var def = defs[filename];
    if (!def) throw new Error("No such module: " + filename);
    def(require, module, module.exports, dirname, filename);
    return module.exports;
  }
}

module.exports = function (main, libPaths) {
  return function* (pathToEntry) {

    var started = {};

    // Gather the defs of the main and all it's recursive dependencies.
    var defs = [];
    yield* load(main);
    // Reverse them to put main at top.
    defs.reverse();

    // Apply the template
    var js = "(" + wrapper.toString() + "(" + JSON.stringify(main) + ", {" +
      defs.map(function (def) {
        return JSON.stringify(def.path) +
          ": function (require, module, exports, __dirname, __filename) {\n" +
          def.code + "\n},\n";
      }).join("") + "}));\n";

    return [200, {"Content-Type":"application/javascript"}, js];

    function* load(path) {
      if (started[path]) return;
      started[path] = true;
      var meta = yield* pathToEntry(path);
      if (!meta) throw new Error("No such file: " + path);
      var code = yield meta.repo.loadAs("text", meta.hash);
      var deps = mine(code);
      var base = pathJoin(path, "..");
      for (var i = deps.length - 1; i >= 0; --i) {
        var dep = deps[i];
        var depName = dep.name;
        if (depName[0] === ".") {
          depName = yield* findLocal(pathJoin(base, depName));
        }
        else {
          depName = yield* findModule(base, depName);
        }
        if (depName) {
          yield* load(depName);
          var offset = dep.offset;
          code = code.substring(0, offset) +
            depName +
            code.substring(offset + dep.name.length);
        }
      }
      defs.push({path: path, code: code});
    }

    function* findLocal(path) {
      var meta = yield* pathToEntry(path);
      if (meta) {
        // Exact match!  Happy days.
        if (modes.isFile(meta.mode)) return path;
        if (meta.mode !== modes.tree) return;
        // Maybe it's a module with a package.json?
        var pkgPath = pathJoin(path, "package.json");
        meta = yield* pathToEntry(pkgPath);
        if (meta && modes.isFile(meta.mode)) {
          var json = yield meta.repo.loadAs("text", meta.hash);
          var pkgInfo = JSON.parse(json);
          if (pkgInfo.main) {
            return yield* findLocal(pathJoin(path, pkgInfo.main));
          }
        }
        var idxPath = pathJoin(path, "index.js");
        meta = yield* pathToEntry(idxPath);
        if (meta && modes.isFile(meta.mode)) return idxPath;
      }
      // Maybe they forgot the extension?
      path = path + ".js";
      meta = yield* pathToEntry(path);
      if (meta && modes.isFile(meta.mode)) return path;
    }

    function* findModule(base, name) {
      for (var i = 0; i < libPaths.length; i++) {
        var result = yield* findLocal(pathJoin(libPaths[i], name));
        if (result) return result;
      }
    }
  };
};
