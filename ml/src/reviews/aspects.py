"""E6: аспекты отзывов и тип книги (решения.md 3.6, список принят ревьюером 11.11).

Набор меток зависит от типа книги: художке — аспекты художки + общие, нон-фикшн — свои + общие; служебные — всем.
Тип — по разделу Amazon (cat2, при смешанных разделах — по подразделу cat3).
"""

# имя → (подпись на сайте, что относится — для разметки и для гипотез NLI)
FICTION = {
    "plot": ("Сюжет", "the plot or story: intrigue, twists, predictability, believability"),
    "characters": ("Персонажи", "the characters: personalities, development, likability"),
    "style": ("Стиль", "the writing style, prose or dialogue"),
    "pace": ("Темп", "the pacing: slow, dragging or fast-moving"),
    "ending": ("Концовка", "the ending"),
    "world": ("Мир и атмосфера", "the setting, world-building or atmosphere"),
}
NONFICTION = {
    "clarity": ("Подача", "how clearly and well-organized the material is presented"),
    "usefulness": ("Практическая польза", "practical usefulness: advice, recipes, exercises, applicability"),
    "depth": ("Глубина", "the depth and amount of detail: thorough or superficial"),
    "accuracy": ("Достоверность", "accuracy and evidence: research, sources, factual errors"),
    "relevance": ("Актуальность", "whether the information is up to date or outdated"),
    "author_view": ("Позиция автора", "the author's tone, bias or self-promotion"),
}
COMMON = {
    "engagement": ("Увлекательность", "how engaging or boring the book is"),
    "editing": ("Редактура", "editing and proofreading: typos, grammar mistakes"),
    "illustrations": ("Иллюстрации", "illustrations, pictures, photos or charts"),
    "audience": ("Кому подойдёт", "who the book is suitable for: age or reader level"),
    "edition": ("Качество издания", "the physical or digital edition: paper, binding, print, formatting"),
}
SERVICE = {
    "none": ("Нет аспекта", "a plot summary or background without an opinion"),
    "overall": ("Общее впечатление", "an overall verdict or recommendation"),
    "delivery": ("Доставка и продавец", "shipping, delivery, seller or price"),
}
# «Кому подойдёт» на сайте — справка («Читатели пишут: подойдёт новичкам»), а не плюс/минус
INFO_ONLY = {"audience"}
SENTIMENTS = ["pos", "neg", "neu"]

FICTION_SUBSECTIONS = {"Literature & Fiction", "Mysteries & Thrillers", "Science Fiction & Fantasy", "Fiction",
                       "Fairy Tales, Folk Tales & Myths"}
# Раздел → тип. Спорные (детские, комиксы) — в художку, кулинария и справочники — в нон-фикшн (ревьюер, 11.11).
SECTION_TYPE = {
    "Literature & Fiction": "fiction",
    "Mystery, Thriller & Suspense": "fiction",
    "Science Fiction & Fantasy": "fiction",
    "Romance": "fiction",
    "Teen & Young Adult": "fiction",
    "Children's Books": "fiction",
    "Comics & Graphic Novels": "fiction",
    "LGBTQ+ Books": "fiction",
    "Boxed Sets": "fiction",
    "Books on CD": "fiction",
    "Large Print": "fiction",
    "Christian Books & Bibles": "nonfiction",   # кроме подраздела Literature & Fiction (христианские романы)
    "Religion & Spirituality": "nonfiction",
    "Humor & Entertainment": "nonfiction",      # юмор-эссе, головоломки, кино и ТВ
    "Biographies & Memoirs": "nonfiction",
    "History": "nonfiction",
    "Cookbooks, Food & Wine": "nonfiction",
    "Crafts, Hobbies & Home": "nonfiction",
    "Arts & Photography": "nonfiction",
    "Politics & Social Sciences": "nonfiction",
    "Business & Money": "nonfiction",
    "Science & Math": "nonfiction",
    "Reference": "nonfiction",
    "Computers & Technology": "nonfiction",
    "New, Used & Rental Textbooks": "nonfiction",
    "Travel": "nonfiction",
    "Health, Fitness & Dieting": "nonfiction",
    "Engineering & Transportation": "nonfiction",
    "Sports & Outdoors": "nonfiction",
    "Education & Teaching": "nonfiction",
    "Self-Help": "nonfiction",
    "Medical Books": "nonfiction",
    "Parenting & Relationships": "nonfiction",
    "Law": "nonfiction",
    "Test Preparation": "nonfiction",
}
DEFAULT_TYPE = "fiction"   # без раздела и мелкие промо-разделы (< 0,1% книг) — художка, её в каталоге больше


def book_type(cat2: str | None, cat3: str | None) -> str:
    if cat3 in FICTION_SUBSECTIONS:
        return "fiction"
    return SECTION_TYPE.get(cat2, DEFAULT_TYPE)


def labels(kind: str) -> dict[str, tuple[str, str]]:
    """Метки аспектов для типа книги: 6 своих + 5 общих + 3 служебных = 14."""
    own = FICTION if kind == "fiction" else NONFICTION
    return {**own, **COMMON, **SERVICE}
