import { useStore, type PathSeg } from '../state/store'
import { isField, isRepeatable, type ResolvedDef } from '../model/schema'
import { canAdd, canRemove, type AnnotationValueTree } from '../model/annotations'
import { Field } from './Field'

interface AnnotationNodeProps {
  def: ResolvedDef
  /** Path to the container tree that holds this node's instances. */
  path: PathSeg[]
  container: AnnotationValueTree
}

export function AnnotationNode({ def, path, container }: AnnotationNodeProps) {
  const addInstance = useStore((s) => s.addInstance)
  const removeInstance = useStore((s) => s.removeInstance)

  const instances = container[def.name] ?? []
  const repeatable = isRepeatable(def)
  const leaf = isField(def) && def.children.length === 0

  // Common case: a single, non-repeatable leaf field on one row.
  if (leaf && !repeatable) {
    const inst = instances[0]
    return (
      <div className="anno-leaf">
        <label className="anno-name" title={def.description}>
          {def.name}
        </label>
        <Field def={def} path={path} index={0} value={inst?.value ?? null} />
      </div>
    )
  }

  return (
    <div className="anno-node">
      <div className="anno-node-header">
        <span className="anno-name" title={def.description}>
          {def.name}
        </span>
        {repeatable && (
          <button
            type="button"
            className="add-btn"
            disabled={!canAdd(def, instances.length)}
            onClick={() => addInstance(path, def)}
          >
            + Add
          </button>
        )}
      </div>

      {instances.map((inst, i) => (
        <div className={repeatable ? 'anno-instance repeatable' : 'anno-instance'} key={i}>
          {repeatable && (
            <div className="anno-instance-bar">
              <span className="anno-instance-idx">#{i + 1}</span>
              <button
                type="button"
                className="remove-btn"
                title="Remove this instance"
                disabled={!canRemove(def, instances.length)}
                onClick={() => removeInstance(path, def.name, i)}
              >
                ×
              </button>
            </div>
          )}

          {isField(def) && (
            <div className="anno-instance-field">
              <Field def={def} path={path} index={i} value={inst.value ?? null} />
            </div>
          )}

          {def.children.length > 0 && inst.children && (
            <div className="anno-children">
              {def.children.map((child) => (
                <AnnotationNode
                  key={child.id}
                  def={child}
                  path={[...path, { name: def.name, index: i }]}
                  container={inst.children!}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
