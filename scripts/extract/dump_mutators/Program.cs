using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Versions;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Objects.UObject;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

// Dumps RGame PrimaryAsset/Data uassets to JSON using CUE4Parse, resolving unversioned
// properties via a Dumper-7-generated .usmap (see scripts/extract/README.md for how to
// regenerate one after a game update).
//
// Usage: dotnet run -- <paksDir> <usmapPath> <outDir>
if (args.Length < 3)
{
    Console.WriteLine("Usage: dotnet run -- <paksDir> <usmapPath> <outDir>");
    return 1;
}
string paksDir = args[0];
string usmapPath = args[1];
string outDir = args[2];
Directory.CreateDirectory(outDir);

var provider = new DefaultFileProvider(paksDir, SearchOption.TopDirectoryOnly, new VersionContainer(EGame.GAME_UE5_6));
provider.MappingsContainer = new CUE4Parse.MappingsProvider.Usmap.FileUsmapTypeMappingsProvider(usmapPath);
provider.Initialize();
provider.Mount();
Console.WriteLine($"Mounted. Files: {provider.Files.Count}");

var jsonSettings = new JsonSerializerSettings
{
    Formatting = Formatting.Indented,
    ReferenceLoopHandling = ReferenceLoopHandling.Ignore,
};

string[] targetDirs = new[]
{
    "RGame/Content/PrimaryAssets/CharacterMutators",
    "RGame/Content/PrimaryAssets/WeaponMutators",
    "RGame/Content/PrimaryAssets/ProjectileMutators",
    "RGame/Content/Data/StringTables",
    "RGame/Content/Data/Localization",
    "RGame/Content/Data/MutatorRewardCategoryData",
};

int ok = 0, fail = 0;
foreach (var kv in provider.Files)
{
    var path = kv.Key;
    if (!path.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase)) continue;
    bool match = false;
    foreach (var d in targetDirs) { if (path.Replace('\\','/').StartsWith(d, StringComparison.OrdinalIgnoreCase)) { match = true; break; } }
    if (!match) continue;

    try
    {
        var pkg = provider.LoadPackage(path);
        var exports = pkg.GetExports().ToList();
        var arr = new JArray();
        foreach (var exp in exports)
        {
            arr.Add(JToken.FromObject(exp, JsonSerializer.Create(jsonSettings)));
        }
        var relPath = path.Replace('\\', '/').Substring("RGame/Content/".Length);
        var outPath = Path.Combine(outDir, relPath + ".json");
        Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
        File.WriteAllText(outPath, arr.ToString(Formatting.Indented));
        ok++;
    }
    catch (Exception ex)
    {
        fail++;
        Console.WriteLine($"FAIL {path}: {ex.Message}");
    }
}
Console.WriteLine($"Done. ok={ok} fail={fail}");
return 0;
