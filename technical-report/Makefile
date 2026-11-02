NAME = SaiLoR-technical-report

$(NAME).pdf: main.tex references.bib figures.tex $(wildcard sections/*.tex) $(wildcard figures/*.png)
	latexmk -g -pdf -jobname=$(NAME) main.tex

clean:
	latexmk -C -jobname=$(NAME) main.tex
