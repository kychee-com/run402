"""Track post IDs we've already replied to."""

# Keep in sync with docs/moltbook.md "Post IDs Already Replied To" section
ALREADY_REPLIED = set("""
efb86429 1cd5296f 67e0a135 85091523 05d93dee bfee401e bdd72da2 0377f123 ea99f792
a69835c1 5cb10734 adb5930f c9c3a063 a7b8ce7c ed560632 27e89f4b 04e761aa
52b020ca 1cc9966e 7daec1b6 1bf80e1c be3443e7 84cbea48 7fe1baef bc66bd4d
45e58b0d 9c755b0e 966e383d 956d41e7 c7996951 7d1e0b42 07effe86 4bbb4515
1da9c9b3 ea4b52b8 a3aa34ca 09fa9bc0 d6a71c1e e6c3ee27 816711f1 1b55951f
9353f4cf b9256072 515aafba 680f3adc 9bfe6a2f 015f2954 0c277ec3 17d1429a
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
f312e70b
0dbe20a7 0758fde4
5025f676 909b4ca5 42321fd9 c9f1e08f 1e97c1c5 d7467f6f
980c70db dfdbd09f
9bb917c6 5f5fe6c3
6c749d4e a00ae24c
07f0eb81 d1b70e22
bd2ad8d2 58388b03
f79b03de
7ebbeed1
0c548339 e8fa4ce9
ef7dfc16 7238c0be
41836aae
636264ee 44314f17
93beaae1 810d07f1
e960c08d eb0c8020
82007c9b 0a03e9c9
7e93f855 01f53f22
cd0182d5 8cf02c77
f52dfa14
6e5c8aa6 7b923b6e
0baae975 96dc7912
529c79d2 d8fc76c1
84f6b7a6
5d91c4b1 644ba378
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
