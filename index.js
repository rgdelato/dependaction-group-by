const core = require("@actions/core");
const fs = require("fs");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const semverDiff = require("semver/functions/diff");
const semverGte = require("semver/functions/gte");

const directories = getStringAsArray(process.argv[2]);
const excludePackages = getStringAsArray(process.argv[3]);
const limit = process.argv[4];

(async function () {
  try {
    // get object of all dependencies from all listed directories
    let allDependencies = getAllDependencies(); // TODO: should we always scan root dir?

    if (directories.length > 0) {
      allDependencies = mergeDependencies(
        allDependencies,
        directories.reduce((acc, path) => {
          return mergeDependencies(acc, getAllDependencies(path));
        }, {})
      );
    }

    // remove excluded packages
    const excludePackageRegexes = excludePackages.map((item) =>
      wildcardToRegExp(item)
    );

    for (const packageName of Object.keys(allDependencies)) {
      for (const re of excludePackageRegexes) {
        if (packageName.match(re)) {
          delete allDependencies[packageName];
        }
      }
    }

    // group data into what's needed for each PR
    const res = await groupDependenciesByScopeAndVersion(allDependencies);

    // allow a limit for testing/rate-limiting
    let limitedRes = res;
    if (limit && !isNaN(limit)) {
      limitedRes = limitedRes.slice(0, Number(limit));
    }

    core.setOutput("matrix", JSON.stringify({ include: limitedRes }));
  } catch (error) {
    core.setFailed(error.message);
  }
})();

/**
 *
 * @param {*} path
 * @returns
 */
function getAllDependencies(path) {
  let allDependencies = {};

  const workspace = process.env["GITHUB_WORKSPACE"] || ".";
  const fullPath = path ? `${workspace}/${path}` : workspace;

  try {
    if (fs.existsSync(`${fullPath}/package.json`)) {
      const { dependencies = {}, devDependencies = {} } = JSON.parse(
        fs.readFileSync(`${fullPath}/package.json`, "utf8")
      );

      allDependencies = mergeDependencies(dependencies, devDependencies);
    } else {
      console.log(`${fullPath}/package.json doesn't exist!`);
    }
  } catch (error) {
    core.setFailed(error.message);
  }

  try {
    if (fs.existsSync(`${fullPath}/packages`)) {
      const packagesFolder = fs.readdirSync(`${fullPath}/packages`, {
        withFileTypes: true,
      });

      for (const moduleFolder of packagesFolder) {
        const moduleDependencies = getAllDependencies(
          `${path ? path + "/" : ""}packages/${moduleFolder.name}`
        );
        allDependencies = mergeDependencies(
          allDependencies,
          moduleDependencies
        );
      }
    }
  } catch (error) {
    core.setFailed(error.message);
  }

  return allDependencies;
}

/**
 * Merge dependencies and always take the lowest version
 *
 * @param {*} dependenciesA
 * @param {*} dependenciesB
 * @returns
 */
function mergeDependencies(dependenciesA, dependenciesB) {
  let result = { ...dependenciesA };

  for (const [packageName, version] of Object.entries(dependenciesB)) {
    if (!result[packageName]) {
      result[packageName] = version;
    } else {
      result[packageName] = getLowerVersion(
        result[packageName],
        dependenciesB[packageName]
      );
    }
  }

  return result;
}

/**
 *
 * @param {*} allDependencies
 */
async function groupDependenciesByScopeAndVersion(allDependencies) {
  let result = [];

  // get metadata for all packages that need to be updated
  let allPackagesWithMetadata = [];

  for (const [packageName, version] of Object.entries(allDependencies)) {
    // skip packages with a current version that is a URL or local path
    if (version.indexOf("/") !== -1 || version.indexOf("file:") !== -1) {
      continue;
    }

    const latestPackageMetadata = await getLatestPackageMetadata(
      packageName,
      "version repository"
    );

    // console.log(packageName, "|", version, "|", latestPackageMetadata.version);

    // skip packages that have no latest version defined
    if (!latestPackageMetadata.version) {
      continue;
    }

    // skip packages that are already at latest or
    // where latest is a lower version than current
    if (semverGte(removeRange(version), latestPackageMetadata.version)) {
      continue;
    }

    allPackagesWithMetadata.push({
      name: packageName,
      currentVersion: removeRange(version),
      latestVersion: latestPackageMetadata.version,
      url: getGitURL(latestPackageMetadata.repository),
    });
  }

  let packagesKeyedByScopeAndVersion = {};
  let typesPackages = {};
  let unscopedPackages = [];

  for (const packageMetadata of allPackagesWithMetadata) {
    const { name: packageName } = packageMetadata;
    const isScoped = packageName.indexOf("/") !== -1;
    const [scopeName, nameWithoutScope] = packageName.split("/");

    if (!isScoped) {
      unscopedPackages.push(packageMetadata);
    } else if (scopeName === "@types") {
      // TODO: Handle @types of scoped packages e.g. "@types/servicetitan__eslint-config"
      typesPackages[nameWithoutScope] = packageMetadata;
    } else {
      const { latestVersion } = packageMetadata;

      if (!packagesKeyedByScopeAndVersion[scopeName]) {
        packagesKeyedByScopeAndVersion[scopeName] = {};
      }

      if (!packagesKeyedByScopeAndVersion[scopeName][latestVersion]) {
        packagesKeyedByScopeAndVersion[scopeName][latestVersion] = [];
      }

      packagesKeyedByScopeAndVersion[scopeName][latestVersion].push(
        packageMetadata
      );
    }
  }

  for (const scope in packagesKeyedByScopeAndVersion) {
    for (const version in packagesKeyedByScopeAndVersion[scope]) {
      const packages = packagesKeyedByScopeAndVersion[scope][version];
      const lowestVersion = getLowestVersionInPackageGroup(packages);

      const current = removeRange(lowestVersion);
      const latest = removeRange(version);
      const semver = semverDiff(current, latest);

      result.push({
        packages,
        scope,
        groupCurrentVersion: current,
        groupLatestVersion: latest,
        semverLabel: semver,
        displayName:
          packages.length > 1 ? `${scope} packages` : packages[0].name,
        hash: getHash(packages),
        prBody: generatePullRequestBody(packages),
      });
    }
  }

  for (const packageData of unscopedPackages) {
    const packages = [packageData];

    if (typesPackages[packageData.name]) {
      packages.push(typesPackages[packageData.name]);
    }

    const current = removeRange(packageData.currentVersion);
    const latest = removeRange(packageData.latestVersion);
    const semver = semverDiff(current, latest);

    result.push({
      packages,
      scope: "",
      groupCurrentVersion: current,
      groupLatestVersion: latest,
      semverLabel: semver,
      displayName: packageData.name,
      hash: getHash(packages),
      prBody: generatePullRequestBody(packages),
    });
  }

  return result;
}

/**
 * Use npm to fetch package data
 *
 * @param {*} packageName
 * @param {*} property
 * @returns
 */
async function getLatestPackageMetadata(packageName, property = "") {
  try {
    const { stdout } = await exec(`npm view ${packageName} ${property} --json`);
    const packageMetadata = JSON.parse(stdout);

    if (packageMetadata) {
      // console.log("packageMetadata:", packageMetadata);
      return packageMetadata;
    }
  } catch (error) {
    core.setFailed(error.message);
  }

  return null;
}

/**
 *
 * @param {*} versionWithRange
 * @returns
 */
function removeRange(versionWithRange) {
  const removeRangeRegex = /\d+.*/g;
  return versionWithRange.match(removeRangeRegex)?.[0];
}

/**
 *
 * @param {*} packagesWithMetadata
 * @returns
 */
function getLowestVersionInPackageGroup(packagesWithMetadata) {
  let lowestVersion;

  for (const { currentVersion } of packagesWithMetadata) {
    if (!lowestVersion) {
      lowestVersion = currentVersion;
    } else {
      lowestVersion = getLowerVersion(lowestVersion, currentVersion);
    }
  }

  return lowestVersion;
}

/**
 * Returns the version string that is lower
 *
 * @param {*} currentWithRange
 * @param {*} latestWithRange
 * @returns
 */
function getLowerVersion(currentWithRange, latestWithRange) {
  const current = removeRange(currentWithRange);
  const latest = removeRange(latestWithRange);

  return semverGte(current, latest) ? latestWithRange : currentWithRange;
}

/**
 *
 * @param {*} packageName
 * @param {*} version
 * @returns
 */
function getHash(packages) {
  const str = packages.map(({ name }) => name).join();
  return unique(str);
}

/**
 *
 * @param {*} repository
 * @returns
 */
function getGitURL(repository) {
  if (repository.type === "git") {
    const urlMatch = repository.url.match(/(git\+)?(.*)\.git/);
    return urlMatch && urlMatch[2];
  }

  return null;
}

/**
 *
 * @param {*} packageData
 * @param {*} gitURLs
 * @returns
 */
function generatePullRequestBody(packagesWithMetadata) {
  let text = "";

  for (const {
    name,
    currentVersion,
    latestVersion,
    url,
  } of packagesWithMetadata) {
    if (url) {
      text += `- Bumps [${name}](${url}) from ${currentVersion} to ${latestVersion}\n`;
    } else {
      text += `- Bumps ${name} from ${currentVersion} to ${latestVersion}\n`;
    }
  }

  return text;
}

/**
 *
 * @param {*} str
 * @returns
 */
function getStringAsArray(str) {
  if (!str) return [];

  return str
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((x) => x !== "");
}

// Wildcard support:
// Source: https://gist.github.com/donmccurdy/6d073ce2c6f3951312dfa45da14a420f

/**
 * Creates a RegExp from the given string, converting asterisks to .* expressions,
 * and escaping all other characters.
 */
function wildcardToRegExp(s) {
  return new RegExp("^" + s.split(/\*+/).map(regExpEscape).join(".*") + "$");
}

/**
 * RegExp-escapes all characters in the given string.
 */
function regExpEscape(s) {
  return s.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

// Short string hashing:
// Source: https://github.com/bibig/node-shorthash/blob/master/shorthash.js

// refer to: http://werxltd.com/wp/2010/05/13/javascript-implementation-of-javas-string-hashcode-method/
function bitwise(str) {
  var hash = 0;
  if (str.length == 0) return hash;
  for (var i = 0; i < str.length; i++) {
    var ch = str.charCodeAt(i);
    hash = (hash << 5) - hash + ch;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash;
}

// 10进制转化成62进制以内的进制
// convert 10 binary to customized binary, max is 62
function binaryTransfer(integer, binary) {
  binary = binary || 62;
  var stack = [];
  var num;
  var result = "";
  var sign = integer < 0 ? "-" : "";

  function table(num) {
    var t = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    return t[num];
  }

  integer = Math.abs(integer);

  while (integer >= binary) {
    num = integer % binary;
    integer = Math.floor(integer / binary);
    stack.push(table(num));
  }

  if (integer > 0) {
    stack.push(table(integer));
  }

  for (var i = stack.length - 1; i >= 0; i--) {
    result += stack[i];
  }

  return sign + result;
}

/**
 * why choose 61 binary, because we need the last element char to replace the minus sign
 * eg: -aGtzd will be ZaGtzd
 */
function unique(text) {
  var id = binaryTransfer(bitwise(text), 61);
  return id.replace("-", "Z");
}
