const core = require("@actions/core");
const fs = require("fs");
const util = require("util");
const exec = util.promisify(require("child_process").exec);

// const directories = getInputAsArray("directories");
// const excludePackages = getInputAsArray("exclude-packages");
// const limit = core.getInput("limit");

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
    for (const packageName of excludePackages) {
      delete allDependencies[packageName];
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
    const latestPackageMetadata = await getLatestPackageMetadata(
      packageName,
      "version repository"
    );

    // skip packages already at latest version
    if (isSameVersion(version, latestPackageMetadata.version)) {
      continue;
    }

    allPackagesWithMetadata.push({
      name: packageName,
      currentVersion: version,
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
      const { semver, current, latest } = compareCurrentAndLatestVersions(
        lowestVersion,
        version
      );

      result.push({
        packages,
        scope,
        groupCurrentVersion: current,
        groupLatestVersion: latest,
        semverLabel: semver,
        displayName:
          packages.length > 1 ? `${scope} packages` : packages[0].name,
        slug: getSlug(packages.length > 1 ? scope : packages[0].name, latest),
        prBody: generatePullRequestBody(packages),
      });
    }
  }

  for (const packageData of unscopedPackages) {
    const packages = [packageData];

    if (typesPackages[packageData.name]) {
      packages.push(typesPackages[packageData.name]);
    }

    const { semver, current, latest } = compareCurrentAndLatestVersions(
      packageData.currentVersion,
      packageData.latestVersion
    );

    result.push({
      packages,
      scope: "",
      groupCurrentVersion: current,
      groupLatestVersion: latest,
      semverLabel: semver,
      displayName: packageData.name,
      slug: getSlug(packageData.name, latest),
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
 * Check if we need to update the package or not
 *
 * @param {*} currentWithRange
 * @param {*} latestWithRange
 * @returns
 */
function isSameVersion(currentWithRange, latestWithRange) {
  const removeRangeRegex = /\d+.*/g;
  const currentMatch = currentWithRange.match(removeRangeRegex);
  const latestMatch = latestWithRange.match(removeRangeRegex);
  const current = currentMatch && currentMatch[0];
  const latest = latestMatch && latestMatch[0];

  return current === latest;
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
 * Get version info for PR (semver, prev version, latest version)
 *
 * @param {*} currentWithRange
 * @param {*} latestWithRange
 * @returns
 */
function compareCurrentAndLatestVersions(currentWithRange, latestWithRange) {
  const removeRangeRegex = /\d+.*/g;
  const currentMatch = currentWithRange.match(removeRangeRegex);
  const latestMatch = latestWithRange.match(removeRangeRegex);
  const current = currentMatch && currentMatch[0];
  const latest = latestMatch && latestMatch[0];

  const majorMinorRegex = /(\d+)\.*(\d*)/;
  const [, currentMajor, currentMinor] = current.match(majorMinorRegex);
  const [, latestMajor, latestMinor] = latest.match(majorMinorRegex);

  let semver;

  if (current === latest) {
    semver = null;
  } else if (currentMajor !== latestMajor) {
    semver = "major";
  } else if (currentMinor !== latestMinor) {
    semver = "minor";
  } else {
    semver = "patch";
  }

  return { semver, current, latest };
}

/**
 * Returns the version string that is lower
 *
 * @param {*} currentWithRange
 * @param {*} latestWithRange
 * @returns
 */
function getLowerVersion(currentWithRange, latestWithRange) {
  const removeRangeRegex = /\d+.*/g;
  const currentMatch = currentWithRange.match(removeRangeRegex);
  const latestMatch = latestWithRange.match(removeRangeRegex);
  const current = currentMatch && currentMatch[0];
  const latest = latestMatch && latestMatch[0];

  const majorMinorRegex = /(\d+)\.*(\d*)\.*(\d*)/;
  const [, currentMajor, currentMinor, currentPatch] =
    current.match(majorMinorRegex);
  const [, latestMajor, latestMinor, latestPatch] =
    latest.match(majorMinorRegex);

  if (current === latest) {
    return current;
  } else if (
    isNaN(currentMajor) ||
    Number(latestMajor) > Number(currentMajor)
  ) {
    return current;
  } else if (isNaN(latestMajor) || Number(currentMajor) > Number(latestMajor)) {
    return latest;
  } else if (
    isNaN(currentMinor) ||
    Number(latestMinor) > Number(currentMinor)
  ) {
    return current;
  } else if (isNaN(latestMinor) || Number(currentMinor) > Number(latestMinor)) {
    return latest;
  } else if (
    isNaN(currentPatch) ||
    Number(latestPatch) > Number(currentPatch)
  ) {
    return current;
  } else if (isNaN(latestPatch) || Number(currentPatch) > Number(latestPatch)) {
    return latest;
  } else {
    // TODO: Also handle versions with suffixes like "6.0.0-beta.8"
    return current;
  }
}

/**
 *
 * @param {*} packageName
 * @param {*} version
 * @returns
 */
function getSlug(packageName = "", version = "") {
  return (
    packageName.toLowerCase().replace("@", "").replace(/\W/g, "_") +
    "-" +
    version.replace(/\D/g, "_")
  );
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

// function getInputAsArray(name, options) {
//   return getStringAsArray(core.getInput(name, options));
// }

function getStringAsArray(str) {
  if (!str) return [];

  return str
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((x) => x !== "");
}
