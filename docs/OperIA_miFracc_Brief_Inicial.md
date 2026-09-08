# OperIA / miFracc — Brief inicial de arranque

Documento de traspaso de contexto, preparado para pegar/subir en la nueva conversación del proyecto **OperIA** en Cowork. Resume lo acordado hasta ahora en el proyecto "Lombardía" sobre este tema, para no perder el hilo al separar los proyectos.

## Estructura corporativa

- **Nexia Soluciones**: empresa ya constituida, se enfoca en consultoría.
- **OperIA**: empresa nueva en trámite de constitución, se enfoca en temas técnicos/producto. Ambas empresas son de Daniel, quien es (o sería) representante legal de las dos. Se facturan cruzado entre sí como parte de la estrategia fiscal.
- Mientras OperIA termina su trámite legal, el trabajo técnico arranca bajo la cuenta personal de GitHub `hiramspeed` (no bajo la organización Nexia Soluciones).
- Nota de cuidado (no legal ni fiscal, solo recordatorio): como Vecinity es hoy propiedad de Nexia Soluciones y se usará como base para un producto de OperIA, conviene que en algún momento quede documentada con abogado/contador la cesión o licencia de esa propiedad intelectual entre las dos empresas.

## Contexto del producto: Vecinity → miFracc

- **Vecinity** es la app actual de Nexia Soluciones para administración y accesos de fraccionamientos/villas. Vive en un repo de GitHub bajo la organización Nexia Soluciones.
- Plan: partir de un **fork** de Vecinity, pero la intención real es una **reingeniería profunda**, no solo una extensión — Vecinity no fue pensada para crecer ni para manejar varios fraccionamientos a la vez, así que se espera terminar reemplazando buena parte de su arquitectura.
- Estrategia de negocio de fondo: eventualmente Vecinity **desaparece de Nexia Soluciones**, que se queda operando solo los flujos de consultoría. El producto técnico (evolución de Vecinity) pasa a vivir en OperIA bajo un nuevo nombre.
- **Nombre del nuevo producto**: provisionalmente **miFracc**, no es definitivo todavía.
- Objetivo comercial: que un administrador (externo o interno) pueda operar **uno o varios fraccionamientos** desde la misma app, y que la venta sea **por módulos activables** — un fraccionamiento puede empezar solo con el módulo de administración y después activar más módulos/funcionalidades si lo necesita.

## Requisitos de arquitectura ya definidos (por el propio Daniel)

- **Multi-tenant con un solo esquema de base de datos**: no instancias separadas por cliente, sino una sola base que soporte múltiples fraccionamientos, cada uno con potencialmente 300+ casas administradas.
- Cada fraccionamiento tiene su propio administrador (externo o interno).
- **Sistema de activación/desactivación muy granular** ("atomizado"), en tres niveles:
  1. Módulos completos (ej. Vigilancia, Administración financiera, Accesos).
  2. Roles específicos dentro de un módulo (ej. apagar el rol/función de "accesos" sin apagar el resto).
  3. Funcionalidades específicas dentro de un módulo (ej. dentro de Vigilancia, poder apagar "accesos" pero mantener activos los "rondines").
- Esto es la versión técnica, a nivel de arquitectura de todo el producto, del mismo principio que ya se validó en el spec funcional de Lombardía (Sesión 2): **subroles/permisos parametrizables por fraccionamiento** — que ningún rol tenga funciones fijas y cerradas, porque cada fraccionamiento/cliente puede necesitar una combinación distinta.

## Decisiones abiertas (a resolver en la primera sesión técnica de OperIA)

- **Stack tecnológico**: no decidido. La instrucción explícita es analizar Vecinity a fondo primero y, si el análisis justifica cambiarlo, cambiarlo sin apego a lo actual.
- **Estado real de Vecinity frente a multi-tenancy**: se asume que "debería" estar preparado para varios fraccionamientos, pero no está confirmado — es el primer punto de auditoría técnica.
- **Modelo técnico del sistema de entitlements/feature flags**: aún no diseñado — debe salir del análisis de Vecinity + la visión de granularidad de arriba (módulo → rol → funcionalidad).
- Acceso al repo: está en la organización GitHub de Nexia Soluciones; se trabajará clonado/movido bajo la cuenta personal `hiramspeed` mientras OperIA se constituye. Carpeta local sugerida por Daniel: `operia-mifracc` dentro de su carpeta de proyectos de desarrollo local.

## Próximos pasos acordados

1. Daniel crea el proyecto **OperIA** en Cowork y conecta la carpeta local correspondiente (repo clonado / carpeta de desarrollo).
2. Primera sesión técnica: auditar Vecinity — arquitectura real, stack, modelo de datos, y específicamente qué tan lejos o cerca está de soportar multi-tenancy real y un sistema de permisos granular como el descrito arriba.
3. Con ese diagnóstico: decidir si se conserva el stack o se cambia, y diseñar el modelo de datos/arquitectura de entitlements (módulo → rol → funcionalidad) por fraccionamiento.
4. Definir nombre final del producto (miFracc es provisional).

## Relación con el proyecto "Lombardía"

Este es un proyecto técnico/de producto separado. El proyecto "Lombardía" sigue existiendo de forma independiente para el trabajo de tesorería (control financiero en Excel) y para las sesiones de levantamiento funcional con Victoria (administradora), que documentan cómo debería funcionar una app de administración de fraccionamientos desde cero. Ese spec funcional (ya en su versión v3, cubre Sesiones 1-3: comunicados, roles, tesorero, comité, vigilancia/rondines) es una **fuente de requerimientos útil** para diseñar miFracc, pero los dos hilos de trabajo — el funcional de Lombardía y el técnico de OperIA — se llevan en proyectos distintos para no mezclar contexto.
