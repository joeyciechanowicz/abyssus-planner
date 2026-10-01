using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Versions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

// Lists or dumps (with Blueprint bytecode) RGame uassets matching a regex.
// Usage: dotnet run -- <paksDir> <usmapPath> list <regex>
//        dotnet run -- <paksDir> <usmapPath> dump <regex> <outDir>
string paksDir = args[0], usmapPath = args[1], mode = args[2];
var provider = new DefaultFileProvider(paksDir, SearchOption.TopDirectoryOnly, new VersionContainer(EGame.GAME_UE5_6));
provider.MappingsContainer = new CUE4Parse.MappingsProvider.Usmap.FileUsmapTypeMappingsProvider(usmapPath);
provider.ReadScriptData = true;
provider.Initialize();
provider.Mount();
var re = new System.Text.RegularExpressions.Regex(args[3], System.Text.RegularExpressions.RegexOptions.IgnoreCase);
var paths = provider.Files.Keys.Where(k => k.EndsWith(".uasset") && re.IsMatch(k)).OrderBy(k => k).ToList();
if (mode == "list")
{
    foreach (var k in paths) Console.WriteLine(k);
    return 0;
}

string outDir = args[4];
var settings = new JsonSerializerSettings { Formatting = Formatting.Indented, ReferenceLoopHandling = ReferenceLoopHandling.Ignore };
int ok = 0, fail = 0;
foreach (var path in paths)
{
    try
    {
        var pkg = provider.LoadPackage(path);
        var arr = new JArray();
        foreach (var exp in pkg.GetExports()) arr.Add(JToken.FromObject(exp, JsonSerializer.Create(settings)));
        var outPath = Path.Combine(outDir, path.Substring("RGame/Content/".Length) + ".json");
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
