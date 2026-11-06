#set page(margin: (x: 28pt, y: 24pt))
#set text(font: "Montserrat", size: 8pt)

#grid(columns: (1fr, 1fr))[
  #set align(horizon)
  #box()[
    #text(size: 8pt, weight: "bold")[Design Round Submission] \
    #text(size: 8pt)[By Himanshu Sardana] \
  ]
][
  #set align(right)
  #image("./image-removebg-preview.png", height: 24pt)
]

#box(outset: 28pt)[
  #line(length: 100%, stroke: (paint: purple, dash: "dashed"))
]

// #box(stroke: (paint: purple, dash: "dashed"), inset: 8pt, radius: 4pt)[
#box(fill: purple.lighten(88%), inset: 8pt, radius: 4pt)[
  #text(size: 10pt, fill: purple, weight: "bold")[#smallcaps()[Initial Thoughts]] \
  Upon first reading the problem statement, I quickly wrote a python script that would send time-stamped data in a random order with _some_ duplication to mirror the conditions mentioned in the problem statement. My plan was to simulate the conditions mentioned in the problem, scale it, figure out where the bottlenecks were and then improve upon them. The code for this can be found #underline(text(fill: purple)[#link("github.com")[here]])
]
