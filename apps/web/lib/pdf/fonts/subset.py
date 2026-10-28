import sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

src = sys.argv[1]
out_dir = sys.argv[2]
# Unicode ranges kept: Latin, punctuation, symbols, kana, CJK ideographs, fullwidth forms.
UNICODES = (
    "U+0000-00FF,U+0100-017F,U+2000-206F,U+2070-209F,U+20A0-20CF,U+2100-214F,U+2190-21FF,"
    "U+2200-22FF,U+2460-24FF,U+2500-257F,U+25A0-25FF,U+2600-26FF,U+3000-303F,U+3040-309F,"
    "U+30A0-30FF,U+31F0-31FF,U+3200-32FF,U+3300-33FF,U+3400-4DBF,U+4E00-9FFF,U+F900-FAFF,"
    "U+FE30-FE4F,U+FF00-FFEF"
)
for weight, name in ((400, "Regular"), (700, "Bold")):
    font = TTFont(src)
    static = instancer.instantiateVariableFont(font, {"wght": weight}, inplace=False, updateFontNames=True)
    tmp = f"{out_dir}/NotoSansJP-{name}.full.ttf"
    static.save(tmp)
    options = subset.Options()
    options.unicodes = subset.parse_unicodes(UNICODES)
    options.layout_features = ["kern", "liga", "palt", "vert"]
    options.hinting = False
    options.name_IDs = ["*"]
    options.notdef_outline = True
    sub = subset.load_font(tmp, options)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=options.unicodes)
    subsetter.subset(sub)
    out = f"{out_dir}/NotoSansJP-{name}.ttf"
    subset.save_font(sub, out, options)
    print(name, "glyphs:", len(sub.getGlyphOrder()))
