NAME = SaiLoR-technical-report

$(NAME).pdf: main.tex references.bib $(wildcard sections/*.tex)
	latexmk -pdf -jobname=$(NAME) main.tex

clean:
	latexmk -C -jobname=$(NAME) main.tex
