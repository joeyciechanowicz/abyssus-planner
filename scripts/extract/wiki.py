"""Shared helpers for pulling data off abyssus.wiki.gg.

The wiki rejects requests without a custom User-Agent (plain urllib gets HTTP 403),
so every request goes through here.
"""
import json
import os
import re
import urllib.parse
import urllib.request

API = "https://abyssus.wiki.gg/api.php"
UA = "abyssus-planner-data/0.1 (contact: bodyloss@gmail.com)"

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(REPO, "data")
PUBLIC = os.path.join(REPO, "public")


def _get(params):
    params = dict(params, format="json")
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def wikitext(page):
    """Raw wikitext of a page."""
    return _get({"action": "parse", "page": page, "prop": "wikitext"})["parse"]["wikitext"]["*"]


def image_urls(file_titles):
    """Map 'File:X.png' -> download URL, batched (the API caps titles per request)."""
    out = {}
    titles = list(file_titles)
    for i in range(0, len(titles), 40):
        batch = titles[i:i + 40]
        d = _get({"action": "query", "titles": "|".join(batch),
                  "prop": "imageinfo", "iiprop": "url|size"})
        # The API normalises underscores to spaces in the titles it echoes back,
        # so map each returned title to the exact string that was asked for.
        back = {n["to"]: n["from"] for n in d["query"].get("normalized", [])}
        for page in d["query"]["pages"].values():
            if "imageinfo" in page:
                title = page["title"]
                out[back.get(title, title)] = page["imageinfo"][0]["url"]
                out[title] = page["imageinfo"][0]["url"]
    return out


def download(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req) as r, open(dest, "wb") as f:
        f.write(r.read())


def clean(s):
    """Strip wiki markup down to plain text."""
    s = re.sub(r"\[\[File:[^\]]*\]\]", "", s)
    s = re.sub(r"\[\[([^\]|]*)\|([^\]]*)\]\]", r"\2", s)
    s = re.sub(r"\[\[([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\{\{anchor\|[^}]*\}\}", "", s, flags=re.I)
    s = re.sub(r"<br\s*/?>", " ", s)
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("'''", "").replace("''", "")
    s = s.replace("�", "'")
    return re.sub(r"\s+", " ", s).strip()


def slug(name):
    return re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_")


def snake(name):
    s = re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_").lower()
    return re.sub(r"_+", "_", s)


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("wrote", path)


def rows_of(table_text):
    """Split a wikitable body into its '|-' delimited rows of cells."""
    rows = []
    for chunk in re.split(r"\n\|-", table_text):
        cells = re.split(r"\n\|(?!\})", chunk)[1:]
        if cells:
            rows.append([c.strip() for c in cells])
    return rows
