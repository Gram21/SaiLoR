import { fieldPath, useAiMark, useStore, type PathSeg } from '../state/store'
import { isField, isRepeatable, type ResolvedDef } from '../model/schema'
import {
  canAdd,
  canRemove,
  isFieldVisible,
  type AnnotationValueTree,
  type FieldValue,
} from '../model/annotations'
import { Field } from './Field'
import { NodeName } from './NodeName'

interface AnnotationNodeProps {
  def: ResolvedDef
  /** Path to the container tree that holds this node's instances. */
  path: PathSeg[]
  container: AnnotationValueTree
  /** Answers of every field along this node's direct ancestor chain, keyed
   *  by name — how a `visibleIf` referencing an ancestor (not just a
   *  same-level sibling) gets resolved. Empty at the root; extended with
   *  this node's own value as it recurses into its children, below. */
  ancestorValues?: Record<string, FieldValue>
}

export function AnnotationNode({ def, path, container, ancestorValues = {} }: AnnotationNodeProps) {
  const addInstance = useStore((s) => s.addInstance)
  const removeInstance = useStore((s) => s.removeInstance)
  // The field currently pulsing after a "jump to this field" request (from
  // Validation) — a plain string, so every node just compares its own
  // canonical path against it rather than each subscribing separately.
  const flashFieldPath = useStore((s) => s.flashFieldPath)
  // Clicking the label of a single-instance field confirms that one field.
  const [, confirmFirst] = useAiMark(path, def.name, 0)

  const instances = container[def.name] ?? []
  const repeatable = isRepeatable(def)
  const leaf = isField(def) && def.children.length === 0

  // Common case: a single, non-repeatable leaf field on one row.
  if (leaf && !repeatable) {
    const inst = instances[0]
    const canonical = fieldPath(path, def.name, 0)
    return (
      <div
        className={`anno-leaf${canonical === flashFieldPath ? ' field-flash' : ''}`}
        data-canonical={canonical}
      >
        <NodeName def={def} onClick={confirmFirst} />
        <Field def={def} path={path} index={0} value={inst?.value ?? null} ariaLabel={def.name} />
      </div>
    )
  }

  // A repeated node shows its name once, above all of its instances, so that one
  // click stands for every instance the label heads. A pure group carries no
  // value, hence nothing to confirm.
  const confirmAll = () => {
    const { currentPaperId, confirmAiMark } = useStore.getState()
    if (!currentPaperId || !isField(def)) return
    instances.forEach((_, i) => confirmAiMark(currentPaperId, fieldPath(path, def.name, i)))
  }

  return (
    <div className="anno-node">
      <div className="anno-node-header">
        <NodeName def={def} onClick={isField(def) ? confirmAll : undefined} />
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

          {isField(def) &&
            (() => {
              const canonical = fieldPath(path, def.name, i)
              return (
                <div
                  className={`anno-instance-field${canonical === flashFieldPath ? ' field-flash' : ''}`}
                  data-canonical={canonical}
                >
                  <Field
                    def={def}
                    path={path}
                    index={i}
                    value={inst.value ?? null}
                    ariaLabel={repeatable ? `${def.name} #${i + 1}` : def.name}
                  />
                </div>
              )
            })()}

          {def.children.length > 0 && inst.children && (
            <div className="anno-children">
              {(() => {
                // This instance's own value joins the ancestor chain handed
                // to its children, so a grandchild's `visibleIf` can reach
                // all the way up — not just to its immediate parent.
                const nextAncestorValues = isField(def)
                  ? { ...ancestorValues, [def.name]: inst.value ?? null }
                  : ancestorValues
                return def.children
                  .filter((child) => isFieldVisible(child, inst.children!, nextAncestorValues))
                  .map((child) => (
                    <AnnotationNode
                      key={child.id}
                      def={child}
                      path={[...path, { name: def.name, index: i }]}
                      container={inst.children!}
                      ancestorValues={nextAncestorValues}
                    />
                  ))
              })()}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
