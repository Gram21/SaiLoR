# Files

- [Annotation Schema and Validation](annotation-schema.md) - How a hand-authored schema in project.json becomes a typed, validated annotation form — AnnotationDef/ResolvedDef types, zod validation, field types, cardinality, required/enum/type/cardinality checks, completeness, and duplicate detection.
- [Project Data Model](data-model.md) - The on-disk split-file project format and the in-memory TypeScript types behind it — the load → normalize → edit → prune → serialize lifecycle, the per-paper-per-reviewer annotation file layout, legacy single-file migration, and the five-state annotation vocabulary.
