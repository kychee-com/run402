"""Track post IDs we've already replied to."""
import os as _os
import json as _json

# File-based dashboard reply tracking (pid_prefix:author pairs)
# This persists across isolated cron runs, unlike in-memory sets.
_DASHBOARD_REPLIED_PATH = _os.path.join(
    _os.path.dirname(__file__), ".dashboard_replied.json"
)

def _load_dashboard_replied() -> set[str]:
    try:
        with open(_DASHBOARD_REPLIED_PATH) as f:
            return set(_json.load(f))
    except (FileNotFoundError, _json.JSONDecodeError):
        return set()

def _save_dashboard_replied(s: set[str]) -> None:
    with open(_DASHBOARD_REPLIED_PATH, "w") as f:
        _json.dump(sorted(s), f)

def dashboard_already_replied(pid: str, author: str) -> bool:
    """Check if we already replied to this author on this post."""
    key = f"{pid[:8]}:{author.lower()}"
    return key in _load_dashboard_replied()

def mark_dashboard_replied(pid: str, author: str) -> None:
    """Mark that we replied to this author on this post."""
    key = f"{pid[:8]}:{author.lower()}"
    s = _load_dashboard_replied()
    s.add(key)
    _save_dashboard_replied(s)


# --- Feed reply tracking (auto-managed JSON, replaces manual ALREADY_REPLIED edits) ---
_FEED_REPLIED_PATH = _os.path.join(
    _os.path.dirname(__file__), ".feed_replied.json"
)

def _load_feed_replied() -> set[str]:
    try:
        with open(_FEED_REPLIED_PATH) as f:
            return set(_json.load(f))
    except (FileNotFoundError, _json.JSONDecodeError):
        return set()

def _save_feed_replied(s: set[str]) -> None:
    with open(_FEED_REPLIED_PATH, "w") as f:
        _json.dump(sorted(s), f)

def feed_already_replied(pid: str) -> bool:
    """Check if we already commented on this post (by 8-char prefix)."""
    return pid[:8] in ALREADY_REPLIED or pid[:8] in _load_feed_replied()

def mark_feed_replied(pid: str) -> None:
    """Mark that we commented on this post."""
    s = _load_feed_replied()
    s.add(pid[:8])
    _save_feed_replied(s)

# Keep in sync with docs/moltbook.md "Post IDs Already Replied To" section
ALREADY_REPLIED = set("""
bddd5ee2
c457d82c
1442d53d 1d751e25
632be250
4f59a32b 56156a83
dffa8c5e
ed2c02f8
6e1dd5c7
5726f807 2594f9ee
abaef44c
a4011c6b 0d6c5b3f 06a57cd9
aad5904a
21bb76ed b7886125
da742b97
758724c7 d4b05971
1b160459
bf939011
d1416a37
e1690d41
61afe9fd
b1ede03a
efb86429 1cd5296f 67e0a135 85091523 05d93dee bfee401e bdd72da2 0377f123 ea99f792
a69835c1 5cb10734 adb5930f c9c3a063 a7b8ce7c ed560632 27e89f4b 04e761aa
52b020ca 1cc9966e 7daec1b6 1bf80e1c be3443e7 84cbea48 7fe1baef bc66bd4d
45e58b0d 9c755b0e 966e383d 956d41e7 c7996951 7d1e0b42 07effe86 4bbb4515
1da9c9b3 ea4b52b8 a3aa34ca 09fa9bc0 d6a71c1e e6c3ee27 816711f1 1b55951f
9353f4cf b9256072 515aafba 680f3adc 9bfe6a2f 015f2954 0c277ec3 17d1429a
26d4d95b
022d6dba 37b8fadd b9869f16 31f1f5b5 f0118067 3d7ddea5 c86bc589 957956a9
002671c4 d9253002 d5ae906d 070e51b9 6647828b 51e21c41 4c1acc23 162cdd28
f5fb04d5 a7af106c c54ae92e 75329390 80fe2d5d 57a44902 7cd126b2 5c3cd340
df6ff97e 88e7e8ba 0ff8b727 21c1ba1e 8f4b8c22 243b1e3a cc274f31 2de218d9
40d5ed64 7dfb26d7 b304cf46 c99d0595 e0c99355 79cfe9e1 dbe187bb f7fb74ca
f6483e85 6a30c12c dc1503de 29361e55 076d2f9b 418115db 252b0c5b d3257f4e
87593037 394fbb1a da19ebc2 f3d4eca9 3e2b9691 9d70c617 38e8c8d6 7fdcc75e
f249cc01 43662793 f0058533 73748f6e 205e57be 8dbc1c83 2a0dc888 1eda42e2
24e1fd35 31fa909a e12d8acf f6d65a7c 7c183360 738f08f4 65725065 364b2e81
d286325f be5c0ca2 2231063e f7fb74ca 0d2d7fb5 a9276fb2 5ee619ce a9f82937
73c2ea8c d2db835a
9dc32a18 8328cf55
2662bbb9 aa505f35
f312e70b
7d3163b1 0bba99f0
0dbe20a7 0758fde4
de1ade56 8e080670
5025f676 909b4ca5 42321fd9 c9f1e08f 1e97c1c5 d7467f6f
980c70db dfdbd09f
9bb917c6 5f5fe6c3
6c749d4e a00ae24c
07f0eb81 d1b70e22
bd2ad8d2 58388b03
b69141c7
41cb9cc3 73a91a80
f79b03de
0c55854a 42b979b5
29a3ed6d 6c03e77e
43020453 1d65b690
bc9f472e 0141a7d1
2933788f 0fae4d8d
6324b7d0
7ebbeed1
0c548339 e8fa4ce9
ef7dfc16 7238c0be
b2ef66cd
41836aae
636264ee 44314f17
d4e4cc91
ced2e2f5 b3293f38
4a23bb3e ca3a53cb
93beaae1 810d07f1
ab104cba 3fe2d96a
e960c08d eb0c8020
907fe1bf a16cdbc5
82007c9b 0a03e9c9
29cb5fcd 1ca080e3
9647316c d0577777
7e93f855 01f53f22
cd0182d5 8cf02c77
71e63d03 33b22a75
f52dfa14
b4d1402f
6e5c8aa6 7b923b6e
0048acd8 c827756f 133180e2
0baae975 96dc7912
529c79d2 d8fc76c1
f1ab0980 24ee13d5
84f6b7a6
5d91c4b1 644ba378
8a09d455 17a50db4
b88e0ddf 265862f7
bd619174 a874a6e5
16892e57 3ab71dec
4b3d09b6 e1071f16
9c4412ab ec4c4dc7
2ad90484 02f97ed3
cb57fb0a
57ee1b4f 91685025
268c0fb7 78ba48f1
087647c5 b6f66a80
60d0ef96 b7c81bdf
11a22935 9b4018a9
ddc3cb69 10d09676
a24b8126 b6513b9c
2ac29e10 43b658de
a676a669 126804c2
c6530b73 7e62e505
50a4fe7b 74efc481
79cc30ea 490c03ce
33d9a2b5 7771dbd4
51852d8a 37191cb3
0607055c 59b7f82d
20f2d277 9a7c36a7
5893c67d 2ae12fc9
bbac6d49
d7ea4f3d 92915110
760da473 ada314fd
c1b9fdff 77e6a178
fc721b81
78824c61
8936885f
c20bf887 12b759a9
124eeeb4 b74a1d49
5e9b7277 e6c4da48
760da473 372653c1
cc6cda59 b164a33c
d0c0ac88
ec7b6f1e 889125bc
f241e624 3ece0f85
d0b63a45 2829c7de
1a90474c b8d71f56
c8045c58 5297b8e8
86bde5d9 5a8cc7d3
73608e74
8d7d97bb 6d187767
0a9d38b5 45db279b
e1576ffc 9fb823d0
a19ab2ec d66c2b6b
d3156ac4
a3ec7e73 f2bb6aa7
ea823b8e 5a34e9e6
fb5a36db
5601fd7b 21c0ca8a
4f30189f b47eab55
a3dc4377 64e482bf
63391533
558ac008 ce3d7297
5049d3b6 7a18d6be
ed922ff5 b5fab2c5
4f96091c c39e0ce6
9cc1b38e 5baa3cf8
9504baf0 d93edb23
9bc1cee6 98a2e40b
1f08e4b8
fac510d0 d2c9e52b
f638c69c 74b6c94c
6e6d0073 41d77db6
eef0401c
6b107079 fdb9fd4a
ce0814b5 c68ded30
4525850f 2b1919b9
3c425697 7d7a41aa
1f51e66f 4194c367
bb92036f 8be5beb8
85d48219 91304e53
bab10aa4 601e9625
fb8b778c 37ac86a9
f2e824ce d4f04bd8
8ba8e1a1 fd1190ec
0c4b8530 0d2b46f7
7f9ad305 b1d3a903
ae332d75 9207351a 08d6d6df ecf80aa8 66effa14
0f8d9cec 52e188ad
1488a0d7 297bb521
27aac59a
bcebde97 c51469c8
1b9bbc00 de50da01
83f7919b 8f52556f
18081fb4 f362b22a
92b483e6 9ef2b319
a01dee4a b4b02413
0ca77b5e 2c691395
510be284 a837d1b1
0ecbe027 2b5f53a0
4a0c36f5
017e6104
57cc1b29 1d976101
a2cc3050 06a2747e
6a040639 a27ff79f
8e399cc5 99ed342c
755bac55 554615c4
667648ac e219830c
d9d645a8
030646e1
debafe39
326ab39f 179ef956
0e113d09
05465def 36995c45
a8f4a120
1e343876 57ee7f23
1005cca3 f4129a7e e7ebc177 fc2c4f56
8a278c96 fabfbfa4
6ed9327f 0ffd1d6a
342f91c1 2e6b27f6
a3e77eff 081eb86d
052dffde 0fc777e8
729191ad cce962a7
91b4f949 d1579dd9
7e9eba27 7402bbab
23effe45 166ae7b9
ece7db7f
6ead7505 0b2f3389
d10474ad 8b093770
c423e04f 71aacc93
6b15d49c 7839902a
3fd8d6cc d14fec8e
a288695e ab5ed386
81727537 cee681bb
147bf050 0ab06175
cac8844f d73176ca
13be9309 c250b5be
f131c7bd 9dfe464c
7103764c
1a9236e1 3515f705
578ac7c3 a4718559
f631f4f7 de2b9ca4
43b0f578 d391e3be
1e8e669a
49083edb b7ab7e56
bab9208e 29e97586
59fb11de
bdcfdec8
4e3681a2
7de98026 cb6cfffa
59efe3a3 ee63a8cc
31bc53ae
6c9c6f89 705ae435
1509e2ec 15af8307
0d4c7025 3b85b504
c9c573dc 0973849b
9728daa2 54de7b3f
eec1786a 8892bc3d
bd0f3dfa af640045
8e971672
979a4903 9d7f5bce
9400ff4e 4127db9b
9679c9e2
e429d604
b8987bc2
837c7ff5
0d61b3e0 3992b69d
99de60bb 0c1ae1ef
905690bd
fe06e542 ba67968f
db0a30b5
95f23143 3331e291
fd045cec 237d02cd
f793088a 7d26c49c
f11142b4 15c7543e
088d23fe 573a77f4
c97d333d f6caa6f1
1e5cf474 36e8b784
b223a5f3 b09f788f
4e80cd5a f1f6b2e2
17d0d676 403426e2
c6f2b661 455e5d73
34df842e f16a1330
424d1872
1f95ea25 bd354195
61a5d665 f13782b9
9004b33d 466d5a88
2dd2e5c1 e89c6556
330aef69
7b1bb6d9 eea55c8f
45aa9c18
5c1388ab
2ae47529 1f350ba0
b9906e7f e3da03e5
15b779cb
951df35b 2597cf55
f1b38b67 968145e7
6b7b2a2f
90695ef4 8fdd2199
f8a8820f 8fef5764
aef0c2c0 2b063caa
3b74d5f4 833cf56f
f9b60f5e 1ab5af4a
f5d1987e 71a8afe6
2839ad4d e6eeefcb
18e932a8 a960baef
f102c187 7f321bdb
a259028f 9f5f1daf
71e63d03 1cda36e3 fba724b8
ceca40c0 166ae7b9
eae2d287 34adad76
59af2e4d f5d90faf
e66ff79b 5963de3f
94d4b4d6 835672ac
b0832f98 a4c79ab7
a89451bf ae883c4d
7b3f6dae 9e39d559
419cf866 cdcb56a4
77ed17a4 69e8a91c
49ce4472 359cb357
151c4a9b 319a53a6
c4d259c2 601fe7ce
8ecb49c7
9a4d1938 f86ee811
031e1222 d81fb375
c09d69ba
28bdb758 c151c640
1bb673c4 df2f53c6
ed0c786c b9bbca15
a5a8a1a3
06a5081f 4f424b15
d83af5eb 11890bb6
c439c477
1e2e1418 83eb517a
1a93264f 2a6fa457
0d235cfa f9b5629f
1d42d4a0
438f8306 d80f9636
2dbe8dc8 732e30b1
e1c6264e
717b0100 aafa472c
9cf58e7a
4c012892 76ab9335
61b63fd6
082f24e8 518e2bfe
64bd1daf
7698a066 d880d347
e5aabfa0
6e411e12 043bd25f
3ea9daf3 1bba7988
b460cb59
c81a2850 c3bb3a2a
3835ede7
f8d70084 43ab595b
2f5c4fd8 c15b2c75
5dee763d e7f0ba25
f809a2b1
847b77c4
e91ab547 b178bce1
9679f040 5a15fac0
cf3645c0 faeead3e
56959638
30c164ca 21d4fb72
def30f5a 0a0a1c8f
8ac3b4b1 563be76c
303ca71d cb08a764
3d589a52 f674c01a
ddf49c77 d0d116b3
d1c8e347 6725fb4b 4977a60f
d035f53a 66c52799
d007885a 74da31d8
d9f6d74d
19a06ad9 c28283df
32646a59 ed2b8555
2e15568d 99a77f81
6cdc4dda 5a34dd52
da03df74 31a22332
db9748fc ece53bd3
c6075da0 221e55c6
8f3b284c 9c015fb2
34e4c5c3 958201c1
1512c6a1 ac3d9323
3594c2df
 73993540 bedaead4
 80627f00 d2381d44
 5ea44ebb 0833332d
 f4f0d168 6378e160
e276fd06 85888c4f
256b0ff1 9d72ea45
ac7c21c4 f628130e
71f47a96
da32d751
d94843ab f4e8d406
d9fe5c18 616aa250
7503fe34 f0ec712c
97d697b5 f587bb96
c50b3ddf 6c44a92f
69775e9c c7cd24ea
da104ba0 1086b6fb
06746dab
79b36a7a 33619b75
d897abb6 92a61b91
f314bfee 4f26bbdd
984e7895 63b0cbef
a2549265 901da2d0
b932cdb7 9fba36f0 ec9a59c9
179be7ac
c94df5cf 0b88c6a5
28f3f66f a2369d0b
3b0760d9 a8a38b49
fcd7f007
96a689c0 e05e4310
3b755b3b 207c73c4
ce519554 05f94ab6
9e9d4207 7155274a
44244f03 179be7ac
09292691 e1563421
0e15ac78 b9f0d2b0
0a2cdb73
d3c3a28a
63f5bc14
217393fa
9810b0f2
7c16b3da d097d0e7
864272f9 b755dd36
7f8b94f5 0a36533a
0502f2db ec27d069
51d23999 60dd22f3
ed81fe42 133180e2
b07923f2 18c7077a
0048acd8 c827756f
3b755b3b 207c73c4 ce519554 05f94ab6
9e9d4207 7155274a 44244f03
4a23bb3e ca3a53cb f1ab0980 24ee13d5
09292691 e1563421 0e15ac78 b9f0d2b0
0a2cdb73 d3c3a28a
217393fa 9810b0f2 7c16b3da d097d0e7
864272f9 b755dd36 7f8b94f5 0a36533a
ced2e2f5 b3293f38 d4e4cc91
0502f2db ec27d069
3bc475cb
1abe215f e41b82f4 0ef62c02
55325fdc
670ad31c
aaf2f693 244b5a62
c68176b4 6a4f4c6a
ebcf8914
d94843ab 13d5bf97
1e495627
58facf55
ee3eeb32 0fbba32b
4c4c89cb 4af7b5b4
c6eb7f17 9bd40d63
df5dafd0 c26495d0
578b1a25 7d94d113
14a58ddc f79b8dc1
96c872c4 89450322
47daa4b1
7ae0a320 ff35ef27
c6b64dfe
56d2dda7
9cf32b2a 27391425
86d53447 2aa6810f
c5eef390 d1416a37
bc12a474
281a9265 d70e62a8
3ef632db 5a697d6f
29a2ab83 5ca6d2c0
172f43d4
136a646d 0d39cfb9
07063077 8029b534
d21ce886 a4adab3b
588a4a18 7a3c42da
7527e629 89534ac1
4700772d 8e5c15d7
5aaa32a3 2be35bfc
c77d4c0d 35d10003
319ed7c1 093820cf
1680265a d8d7bc5d
c975f904
944f0665
529b4120 3016129e
ee03deb1 2ac59490
82038dc5
42aff2fa 240dedb8
e7d540dc c15914ab
914a3e7f 8e007b80
ac02ee9d
3778f04e 8e71c17a 55b49316
cd76893d
bbcfa16d 4d0f67e5
ae1b4d97 7ae796c4
08f83447 6adf6eb9
f8fdb324
a1cf94f1 2bc863d7
f5299a78 bb17f396
b43736f1 372ef815
0b042414 41df4f5d
431dcffd 6de17a72
58eb72eb 0e856405
cfde482a fec17e99
dba05d3f b036603a
a8da0d51 6591649b
6f489a0a db7cbaef
8727d67d
31b419d3 e89526eb
d316c238 7407d4d9
7dc1e488
3ee59e46 e4c71912
1de223fa db3f205a
0730a915 a9a10321
918c7cc1
87450ec0 6cb68624
55a10fb6 676a42c7
e3004929 bd6e1559
8a67c9a2 96364bfb
d5332ce3 13165619
052848c2 a5c0393c
26968b4d d3ae0ad0
23d63285
97ed7fcc 8b4597a0
7a8469d0 fc2b088d
a0401906 23ff1d91
8b4597a0 49c03f08
b02e5410 f7968f06
59380dce 99651af4
d9064c35 9fd7d7b3 09a067fd 08ffb1c1
48cdd148 4b138716
c04df71c d2be044e 8b4597a0
9e0007c0 00078897
d0590c61
14d2a4a2 99809853
43638484
392792f2 ca920327
1e05db71 f9c887f4
e77bb929 191c08a0
5f3ea4a2 6783b6d5
c5058717 396bcab0
4ad68412 28a480aa
e5ba1066 6f737c86
14e9e770 f28ce2b9
bb68eae3 9f235802
74f42ffc a9956521
a08e2bdc e936b832
d83b2306 f398b739
b44d4109
695fd1cc d1006cee
3497ada7 f8cc2bf4
66a2222c
b3709e60 e73d5321
5ff938ff 620d2626
a0d80fbd 85cacd55
d4ca8286 7323209d
7cd62958 b5c4dd8a
8077ab05 9f824128
2c404dbe
cb057a90 ed0bdd36
020c1be3 c32af27e
4e1ef1ba 912c1258
a5462c27
13318b78 0f16a552 e6501dc5
3e281c69 82b983f5
52eb806f e358244a
9bd2502b 6448dfb8
7ada787e 61ace6d3
6c586378 8b8778e1
eff02329 29da48c3
e1868bb2
3e79cc2c
d0fa7357 bcd338a2
9a68f6c9 0fac2f33
f7449762 5b41f27c
c2b598fe a474ace7
39060329 91de55e2
e693fc24
dc39fba0
592ee07a
e71f5b6a
aedeac8f
ae654c2c
9197b8eb
1d9b900e
69f6d1a9
1de7c950
7dd4d949
3857e629
8dd6f6d5
59db1a21
6b208036
4bc0e508
82776c7e
c48c031b
64f0e82a
30e01f48
8b1d6b00
7c50ddf2
""".split())

SKIP_TOPICS = [
    "banking", "tax", "kyc", "market wrap", "fed rate", "manifesto", "ar-net",
    "poem", "verse", "song", "airdrop", "degen", "farming", "minting", "nft",
    "token launch", "presale", "rug pull", "horoscope", "astrology", "daily log",
    "day log", "worship", "prayer", "hydrogen", "观察日记", "人类世界",
]

INFRA_KEYWORDS = [
    "infrastructure", "deploy", "cloud", "payment", "autonomous", "wallet",
    "compute", "database", "state", "persist", "cost", "spend", "cron",
    "worker", "server", "provision", "infra", "memory", "storage", "api",
    "credential", "billing", "economic", "docker", "kubernetes", "postgres",
    "budget", "receipt", "migration", "x402", "mpp", "tempo", "stripe", "protocol",
]
