using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Versions;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse_Conversion.Textures;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SkiaSharp;

// Sibling of dump_mutators: dumps the primary data assets that carry icon references
// (weapons, mutators/charms/abilities, weapon mods) to JSON, and decodes the UI
// Texture2D assets they point at to PNG. scripts/extract/game_icons.py then matches
// the dumped assets to data/*.json entries and copies the right PNGs into public/.
//
// Usage:
//   dotnet run -- <paksDir> <usmapPath> <outDir>          dump assets + textures
//   dotnet run -- <paksDir> <usmapPath> <outDir> list     also write every pak path to <outDir>/paths.txt
//
// Output layout:
//   <outDir>/assets/<path under RGame/Content>.json   one JSON array of exports per uasset
//   <outDir>/textures/<path under RGame/Content>.png  one PNG per decoded Texture2D
if (args.Length < 3)
{
    Console.WriteLine("Usage: dotnet run -- <paksDir> <usmapPath> <outDir> [list]");
    return 1;
}
string paksDir = args[0];
string usmapPath = args[1];
string outDir = args[2];
bool list = args.Length > 3 && args[3] == "list";
Directory.CreateDirectory(outDir);

var provider = new DefaultFileProvider(paksDir, SearchOption.TopDirectoryOnly, new VersionContainer(EGame.GAME_UE5_6));
provider.MappingsContainer = new CUE4Parse.MappingsProvider.Usmap.FileUsmapTypeMappingsProvider(usmapPath);
provider.Initialize();
provider.Mount();
Console.WriteLine($"Mounted. Files: {provider.Files.Count}");

if (list)
    File.WriteAllLines(Path.Combine(outDir, "paths.txt"), provider.Files.Keys.OrderBy(k => k));

const string Root = "RGame/Content/";

// Data assets whose properties reference icons.
string[] assetDirs =
{
    "RGame/Content/PrimaryAssets/",
};
// UI art: every Texture2D under here is decoded (a few hundred small files).
string[] textureDirs =
{
    "RGame/Content/Art/UI/Abilities/",
    "RGame/Content/Art/UI/Weapon/",
    "RGame/Content/Art/UI/Mutators/",
    "RGame/Content/Art/UI/General/",
    "RGame/Content/Art/UI/SkillTree/",
};

bool Under(string path, string[] dirs) =>
    dirs.Any(d => path.Replace('\\', '/').StartsWith(d, StringComparison.OrdinalIgnoreCase));

string Rel(string path) => path.Replace('\\', '/').Substring(Root.Length);

var jsonSettings = new JsonSerializerSettings
{
    Formatting = Formatting.Indented,
    ReferenceLoopHandling = ReferenceLoopHandling.Ignore,
};
var serializer = JsonSerializer.Create(jsonSettings);

int assetsOk = 0, texOk = 0, fail = 0;
foreach (var path in provider.Files.Keys.ToList())
{
    if (!path.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase)) continue;
    bool isAsset = Under(path, assetDirs);
    bool isTex = Under(path, textureDirs);
    if (!isAsset && !isTex) continue;

    try
    {
        var pkg = provider.LoadPackage(path);
        var exports = pkg.GetExports().ToList();
        var rel = Rel(path);
        rel = rel.Substring(0, rel.Length - ".uasset".Length);

        if (isAsset)
        {
            var arr = new JArray();
            foreach (var exp in exports) arr.Add(JToken.FromObject(exp, serializer));
            var outPath = Path.Combine(outDir, "assets", rel + ".json");
            Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
            File.WriteAllText(outPath, arr.ToString(Formatting.Indented));
            assetsOk++;
        }

        if (isTex)
        {
            foreach (var tex in exports.OfType<UTexture2D>())
            {
                var ctex = tex.Decode();
                if (ctex == null) { Console.WriteLine($"NODECODE {path}"); fail++; continue; }
                using var bmp = ctex.ToSkBitmap();
                var outPath = Path.Combine(outDir, "textures", rel + ".png");
                Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
                using var data = bmp.Encode(SKEncodedImageFormat.Png, 100);
                using var fs = File.Create(outPath);
                data.SaveTo(fs);
                texOk++;
            }
        }
    }
    catch (Exception ex)
    {
        fail++;
        Console.WriteLine($"FAIL {path}: {ex.Message}");
    }
}
Console.WriteLine($"Done. assets={assetsOk} textures={texOk} fail={fail}");
return 0;
